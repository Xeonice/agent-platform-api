import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRuntimeLogReader } from '../../../src/platform/logging/runtime-log-reader';
import { RuntimeLogWriter } from '../../../src/platform/logging/runtime-log-writer';

/**
 * `RUNTIME_LOG_READER` 是审计导出端点(P21-5 §10.3 的 `runtime.log` 那一份)消费的
 * 只读出口。**形状与导出端定死,不许改**:
 *   `read(opts: { from?: Date; to?: Date; maxBytes: number }): NodeJS.ReadableStream | null`
 *
 * MUTATION 验证过会红:
 * | 变异 | 结果 |
 * |---|---|
 * | `planWithinBudget` 从**最旧**一端开始收(`for (let i = 0; …)`) | 「超上限时保留的是最近的」红 |
 * | `emit` 里去掉 `if (fromMs …) continue` | 「时间范围过滤」红 |
 * | `read` 在无文件时返回空流而不是 `null` | 「没有日志时返回 null」红 |
 * | `emit` 里不丢被字节预算截断的半截首行 | 「留下的每一行都以时间戳开头」红 |
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runtime-log-read-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function drain(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) throw new Error('reader 返回了 null');
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

const stamped = (iso: string, body: string): string => `${iso} LOG     ${body}`;

describe('FileRuntimeLogReader', () => {
  it('一份日志都没写过 ⇒ 返回 null(而不是空流)', async () => {
    const writer = new RuntimeLogWriter({ dir, maxBytes: 1000, maxFiles: 3 });
    await writer.close();
    rmSync(writer.currentPath);
    // 让导出端能区分「没有日志设施」与「范围内没内容」—— 前者要在包里注明。
    expect(new FileRuntimeLogReader(writer).read({ maxBytes: 1000 })).toBeNull();
  });

  it('按时间序拼接多份轮转文件(旧 → 新)', async () => {
    const writer = new RuntimeLogWriter({ dir, maxBytes: 60, maxFiles: 5 });
    for (let i = 1; i <= 6; i++) {
      writer.write(stamped(`2026-08-27T00:00:0${i}.000Z`, `event-${i}`));
    }
    await writer.whenIdle();
    await writer.close();

    const text = await drain(new FileRuntimeLogReader(writer).read({ maxBytes: 1_000_000 }));
    const order = [...text.matchAll(/event-(\d)/g)].map((m) => Number(m[1]));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).toContain(6);
  });

  it('时间范围过滤 [from, to]', async () => {
    const writer = new RuntimeLogWriter({ dir, maxBytes: 1_000_000, maxFiles: 3 });
    writer.write(stamped('2026-08-26T00:00:00.000Z', 'too-old'));
    writer.write(stamped('2026-08-27T00:00:00.000Z', 'in-range'));
    writer.write(stamped('2026-08-28T00:00:00.000Z', 'too-new'));
    await writer.close();

    const text = await drain(
      new FileRuntimeLogReader(writer).read({
        from: new Date('2026-08-26T12:00:00.000Z'),
        to: new Date('2026-08-27T12:00:00.000Z'),
        maxBytes: 1_000_000,
      }),
    );
    expect(text).toContain('in-range');
    expect(text).not.toContain('too-old');
    expect(text).not.toContain('too-new');
  });

  it('栈的续行没有自己的时间戳 —— 沿用上一条,不会被时间过滤切成半截', async () => {
    const writer = new RuntimeLogWriter({ dir, maxBytes: 1_000_000, maxFiles: 3 });
    writer.write(stamped('2026-08-27T00:00:00.000Z', 'Error: boom'));
    writer.write('    at somewhere.ts:12:3');
    await writer.close();

    const text = await drain(
      new FileRuntimeLogReader(writer).read({
        from: new Date('2026-08-27T00:00:00.000Z'),
        maxBytes: 1_000_000,
      }),
    );
    expect(text).toContain('Error: boom');
    expect(text).toContain('at somewhere.ts:12:3');
  });

  it('超 maxBytes 时截掉的是**旧**的一头,留下最近的(P21-5 §10.3「先到者」)', async () => {
    const writer = new RuntimeLogWriter({ dir, maxBytes: 1_000_000, maxFiles: 3 });
    for (let i = 1; i <= 50; i++) {
      writer.write(stamped('2026-08-27T00:00:00.000Z', `event-${String(i).padStart(3, '0')}`));
    }
    await writer.close();

    const text = await drain(new FileRuntimeLogReader(writer).read({ maxBytes: 200 }));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(200);
    expect(text).toContain('event-050');
    expect(text).not.toContain('event-001');
    // 被截断的半截行必须丢掉,不能吐一行残缺的日志出去。
    for (const line of text.split('\n').filter((l) => l.length > 0)) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
