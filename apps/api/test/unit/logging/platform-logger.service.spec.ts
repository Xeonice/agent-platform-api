import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '@platform/shared-kernel';
import { PlatformLoggerService } from '../../../src/platform/logging/platform-logger.service';
import { RuntimeLogWriter } from '../../../src/platform/logging/runtime-log-writer';

/**
 * shared/11 §1.2.1 的两条硬要求,一条一条钉住:
 *   - **落盘不替代 stdout**(`docker compose logs` 是运维第一反应)⇒ 两条出口都要有
 *   - **脱敏在写入口**(05 §4 / P21-5 §10.5)⇒ 明文不许出现在落盘文件里
 *
 * MUTATION 验证过会红:
 * | 变异 | 结果 |
 * |---|---|
 * | `emit` 里 `redactLogLine(raw)` 换成 `raw` | 「明文不落盘」红 |
 * | `emit` 里两行 `this.console[level](…)` 删掉 | 「stdout 并存」红 |
 * | 落盘行去掉 `${stamp} ` 前缀 | 「行首是 ISO 时间戳」红(reader 的时间过滤全靠它) |
 */

const FROZEN = '2026-08-27T04:05:06.789Z';
const fixedClock: Clock = { now: () => new Date(FROZEN) };

let dir: string;
let writer: RuntimeLogWriter;
let logger: PlatformLoggerService;
// ⚠️ `ReturnType<typeof vi.spyOn>` 是**泛型未实例化**的形态，接不住
//    `process.stdout.write` 那个重载签名。⇒ 直接取那两个 spy 的实际类型。
// ⚠️ `ReturnType<typeof vi.spyOn>` 是**泛型未实例化**的形态，接不住
//    `process.stdout.write` 那个重载签名。⇒ 用 `MockInstance` 直接描述被 spy 的那个函数。
let stdout: MockInstance<typeof process.stdout.write>;
let stderr: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runtime-logger-'));
  writer = new RuntimeLogWriter({ dir, maxBytes: 1_000_000, maxFiles: 5 });
  logger = new PlatformLoggerService(fixedClock, writer);
  // stdout + stderr 都拦:Nest ConsoleLogger 把 error/fatal 打到 stderr,
  // 只拦 stdout 会让「明文不上控制台」这条断言漏掉一半出口(而且测试输出会被刷屏)。
  stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(async () => {
  stdout.mockRestore();
  stderr.mockRestore();
  await writer.close();
  rmSync(dir, { recursive: true, force: true });
});

async function fileContents(): Promise<string> {
  await writer.whenIdle();
  await writer.close();
  return readFileSync(writer.currentPath, 'utf8');
}

function consoleText(): string {
  return [...stdout.mock.calls, ...stderr.mock.calls].map((c) => String(c[0])).join('');
}

describe('PlatformLoggerService', () => {
  it('落盘行 = ISO 时间戳 + 级别 + [context] + 正文(时间来自 Clock 端口)', async () => {
    logger.log('sandbox sbx-1 provisioned', 'SandboxService');
    const text = await fileContents();
    expect(text).toBe(`${FROZEN} LOG     [SandboxService] sandbox sbx-1 provisioned\n`);
  });

  it('落盘**不替代** stdout —— 同一条日志两条出口都有', async () => {
    logger.warn('bound to 0.0.0.0', 'Bootstrap');
    // 先看 stdout(close 之前 spy 还在)。
    expect(consoleText()).toContain('bound to 0.0.0.0');
    expect(await fileContents()).toContain('bound to 0.0.0.0');
  });

  it('脱敏在写入口:明文既不落盘,也不上 stdout', async () => {
    const secret = 'sk-ant-oat01-PLAINTEXT0123456789';
    logger.error(`refresh failed for ${secret}`, 'CredentialVault');

    expect(consoleText()).not.toContain(secret);
    const text = await fileContents();
    expect(text, '明文落盘 ⇒ 导出/备份/直接读文件三条路都漏').not.toContain(secret);
    expect(text).toContain('sk-ant-oat01-***');
  });

  it('Error 入参落盘的是栈(运行日志相对审计流的唯一价值,P21-5 §10.1)', async () => {
    const err = new Error('boom');
    logger.error(err, 'SandboxService');
    const text = await fileContents();
    expect(text).toContain('Error: boom');
    expect(text).toContain('platform-logger.service.spec.ts');
  });

  it('六个级别都写(fatal / verbose 也不许掉进黑洞)', async () => {
    logger.log('a');
    logger.error('b');
    logger.warn('c');
    logger.debug('d');
    logger.verbose('e');
    logger.fatal('f');
    const lines = (await fileContents()).trim().split('\n');
    expect(lines.map((l) => l.split(/\s+/)[1])).toEqual([
      'LOG',
      'ERROR',
      'WARN',
      'DEBUG',
      'VERBOSE',
      'FATAL',
    ]);
  });

  it('对象入参序列化后同样过脱敏(第三方库把整份 body 打出来的那种)', async () => {
    logger.log({ refresh_token: 'rt-super-secret' }, 'RuntimeAdapter');
    const text = await fileContents();
    expect(text).not.toContain('rt-super-secret');
  });
});
