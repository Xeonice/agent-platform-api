import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { extract as tarExtract } from 'tar';
import type { Clock } from '@platform/shared-kernel';
import { AuditRepository } from '../../src/platform/audit/audit.repository';
import {
  AuditExportService,
  EXPORT_MAX_BYTES,
} from '../../src/platform/audit/audit-export.service';
import type { RuntimeLogReader } from '../../src/platform/logging';

/**
 * 导出包（P21-5 §10.3 / 10 §6.6）。
 *
 * 本文件盯三件事：
 *   · 包是用 **npm `tar`** 打的（⛔ 不 shell out：开发机 BSD tar vs 镜像 GNU tar 1.34
 *     同参数行为不同，已实测）—— 所以这里也用同一个库解包，端到端自洽；
 *   · **24h 窗口**真的过滤了更早的记录；
 *   · **`runtime.log` 的 provider 没 bound 时导出仍然可用**，且缺失原因写在包里
 *     （「截断了却不说，会让人以为日志本来就只有这些」）。
 */
type Db = BetterSQLite3Database<Record<string, never>>;

const NOW_MS = Date.parse('2026-08-27T12:00:00.000Z');
const clock: Clock = { now: () => new Date(NOW_MS) };

let sqlite: Database.Database;
let repo: AuditRepository;
let workdir: string;

beforeEach(() => {
  sqlite = new Database(':memory:');
  const db: Db = drizzle(sqlite);
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  repo = new AuditRepository(db);
  workdir = mkdtempSync(join(tmpdir(), 'audit-export-int-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  sqlite.close();
});

function seedAt(atMs: number, summary: string): void {
  sqlite
    .prepare(
      `INSERT INTO audit_events (at, category, type, severity, actor, summary)
       VALUES (?, 'system', 'test.seed', 'info', 'system', ?)`,
    )
    .run(atMs, summary);
}

async function unpack(service: AuditExportService): Promise<{
  files: string[];
  read: (name: string) => string;
}> {
  const packed = await service.pack();
  await tarExtract({ file: packed.path, cwd: workdir });
  await packed.dispose();
  const read = (name: string): string => readFileSync(join(workdir, name), 'utf8');
  const files = ['audit.jsonl', 'export-range.json', 'diagnose.json', 'runtime.log'].filter((f) => {
    try {
      readFileSync(join(workdir, f));
      return true;
    } catch {
      return false;
    }
  });
  return { files, read };
}

describe('audit export —— 24h 窗口', () => {
  it('窗口内的进包，25 小时前的不进', async () => {
    seedAt(NOW_MS - 60_000, 'inside');
    seedAt(NOW_MS - 25 * 3600 * 1000, 'outside');
    const { read } = await unpack(new AuditExportService(repo, clock));
    const jsonl = read('audit.jsonl');
    expect(jsonl).toContain('inside');
    expect(jsonl).not.toContain('outside');

    const range = JSON.parse(read('export-range.json'));
    expect(range.audit.events).toBe(1);
    expect(range.requestedWindow.from).toBe(new Date(NOW_MS - 24 * 3600 * 1000).toISOString());
    expect(range.maxBytes).toBe(EXPORT_MAX_BYTES);
  });
});

describe('audit export —— RUNTIME_LOG_READER 的三种结局都要说清是哪一种', () => {
  /**
   * ⚠️ **provider 未 bound 时导出仍然可用。** 日志落盘是另一条并行切片；
   * 「日志落盘未实现」不该让「导出审计流」也用不了 —— 500 会把整个按钮变成死的。
   */
  it('provider 未 bound ⇒ 省掉 runtime.log，并写清缺失原因（不报错）', async () => {
    seedAt(NOW_MS - 1000, 'x');
    const { files, read } = await unpack(new AuditExportService(repo, clock));
    expect(files).not.toContain('runtime.log');
    const range = JSON.parse(read('export-range.json'));
    expect(range.runtimeLog.included).toBe(false);
    expect(range.runtimeLog.omittedReason).toContain('RUNTIME_LOG_READER');
  });

  it('reader 回 null（设施在、还没写过） ⇒ 同样省掉，但原因不一样', async () => {
    seedAt(NOW_MS - 1000, 'x');
    const reader: RuntimeLogReader = { read: () => null };
    const { files, read } = await unpack(new AuditExportService(repo, clock, reader));
    expect(files).not.toContain('runtime.log');
    const reason = String(JSON.parse(read('export-range.json')).runtimeLog.omittedReason);
    // 「平台还没在存日志」与「这段时间没有日志」是两件事，包里必须分得开。
    expect(reason).not.toContain('RUNTIME_LOG_READER');
    expect(reason).toContain('还没有写过');
  });

  it('reader 抛异常 ⇒ 导出照样成功，原因如实记下', async () => {
    seedAt(NOW_MS - 1000, 'x');
    const reader: RuntimeLogReader = {
      read: () => {
        throw new Error('log dir vanished');
      },
    };
    const { files, read } = await unpack(new AuditExportService(repo, clock, reader));
    expect(files).not.toContain('runtime.log');
    expect(String(JSON.parse(read('export-range.json')).runtimeLog.omittedReason)).toContain(
      'log dir vanished',
    );
  });

  it('reader 给了流 ⇒ runtime.log 进包，字节数记在范围说明里', async () => {
    seedAt(NOW_MS - 1000, 'x');
    const reader: RuntimeLogReader = { read: () => Readable.from(['line-a\nline-b\n']) };
    const { files, read } = await unpack(new AuditExportService(repo, clock, reader));
    expect(files).toContain('runtime.log');
    expect(read('runtime.log')).toBe('line-a\nline-b\n');
    const range = JSON.parse(read('export-range.json'));
    expect(range.runtimeLog).toMatchObject({ included: true, bytes: 14, truncated: false });
  });

  it('reader 拿到的字节预算是 50MB 的剩余那一份，不是 0、也不是无穷', async () => {
    let seen = -1;
    const reader: RuntimeLogReader = {
      read: (opts) => {
        seen = opts.maxBytes;
        return null;
      },
    };
    await unpack(new AuditExportService(repo, clock, reader));
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThan(EXPORT_MAX_BYTES);
  });
});

describe('audit export —— diagnose.json 不假装跑过一轮检查', () => {
  it('checks 是空的，并附一句说明为什么', async () => {
    const { read } = await unpack(new AuditExportService(repo, clock));
    const diagnose = JSON.parse(read('diagnose.json'));
    // ⚠️ 编一份"全绿"的诊断快照，比没有诊断快照坏得多 —— 读者会据此排除掉本该查的方向。
    expect(diagnose.checks).toEqual([]);
    expect(String(diagnose.checksUnavailable)).toContain('尚未落地');
    expect(diagnose.resources.cpuCount).toBeGreaterThan(0);
  });
});

describe('audit export —— 临时目录不留在盘上', () => {
  it('dispose() 之后包与其中间产物都没了', async () => {
    seedAt(NOW_MS - 1000, 'x');
    const service = new AuditExportService(repo, clock);
    const packed = await service.pack();
    expect(() => readFileSync(packed.path)).not.toThrow();
    await packed.dispose();
    // 那个目录里装着刚导出的（已脱敏但仍敏感的）运行日志 —— 留在 /tmp 是个泄漏面。
    expect(() => readFileSync(packed.path)).toThrow();
  });
});
