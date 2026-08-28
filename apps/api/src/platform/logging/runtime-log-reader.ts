import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import type { RuntimeLogWriter } from './runtime-log-writer';

export interface RuntimeLogReadOptions {
  /** 起始时间（含）。缺省 = 不设下界。 */
  from?: Date;
  /** 结束时间（含）。缺省 = 不设上界。 */
  to?: Date;
  /** 字节上限。**取「时间范围」与「字节上限」先到的那个**（P21-5 §10.3）。 */
  maxBytes: number;
}

/**
 * 审计导出端点消费的只读出口（P21-5 §10.3 的 `runtime.log` 那一份）。
 *
 * ⚠️ **这个形状是与导出端定死的契约，不要改**：
 *   `{ read(opts: { from?: Date; to?: Date; maxBytes: number }): NodeJS.ReadableStream | null }`
 *
 * 一份日志都没有时返回 `null`（而不是空流）—— 让调用方能区分「没有日志设施 / 还没
 * 写过日志」与「时间范围内没有内容」，前者在导出包里应当注明，后者只是空文件。
 */
export interface RuntimeLogReader {
  read(opts: RuntimeLogReadOptions): NodeJS.ReadableStream | null;
}

/** DI token。导出端 `@Inject(RUNTIME_LOG_READER)` 拿到上面的接口。 */
export const RUNTIME_LOG_READER = Symbol('RUNTIME_LOG_READER');

/** 行首 ISO 时间戳 —— `PlatformLoggerService` 写的每一行都以它开头。 */
const LINE_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s/;

interface ReadPlanEntry {
  path: string;
  /** 从文件的第几个字节开始读（>0 时首行是半截，丢弃）。 */
  start: number;
}

/**
 * 落盘文件的 reader。**不自己算路径** —— 路径由 writer 持有，两边只有一处定义，
 * 免得轮转命名改了 reader 还在找旧名字（那又是一次「日志照写、没人找得到」）。
 */
export class FileRuntimeLogReader implements RuntimeLogReader {
  constructor(private readonly writer: RuntimeLogWriter) {}

  read(opts: RuntimeLogReadOptions): NodeJS.ReadableStream | null {
    const paths = this.writer.existingPaths(); // 从旧到新
    if (paths.length === 0) return null;

    const plan = planWithinBudget(paths, opts.maxBytes);
    if (plan.length === 0) return null;

    const fromMs = opts.from?.getTime();
    const toMs = opts.to?.getTime();
    return Readable.from(emit(plan, fromMs, toMs, opts.maxBytes), { objectMode: false });
  }
}

/**
 * 从**最新**一端倒着收，直到把 `maxBytes` 用光 —— 导出要的是「最近的那些」，
 * 截断必须发生在旧的一头。返回的计划仍是从旧到新，直接顺读就是时间序。
 */
function planWithinBudget(paths: string[], maxBytes: number): ReadPlanEntry[] {
  const plan: ReadPlanEntry[] = [];
  let budget = maxBytes;
  for (let i = paths.length - 1; i >= 0 && budget > 0; i--) {
    const path = paths[i]!;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      continue; // 读的同时被轮转移走了 —— 跳过，不让导出因此 500
    }
    if (size === 0) continue;
    if (size <= budget) {
      plan.unshift({ path, start: 0 });
      budget -= size;
    } else {
      plan.unshift({ path, start: size - budget });
      budget = 0;
    }
  }
  return plan;
}

async function* emit(
  plan: ReadPlanEntry[],
  fromMs: number | undefined,
  toMs: number | undefined,
  maxBytes: number,
): AsyncGenerator<Buffer> {
  let written = 0;
  // 栈行等续行没有自己的时间戳,沿用上一条有戳的行 —— 否则一条报错的栈会被
  // 时间过滤切成两半,而栈正是运行日志相对审计流的**唯一**价值(P21-5 §10.1)。
  let lastMs: number | undefined;

  for (const entry of plan) {
    let stream;
    try {
      stream = createReadStream(entry.path, { start: entry.start });
    } catch {
      continue;
    }
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let first = true;
    for await (const line of rl) {
      if (first) {
        first = false;
        // start > 0 ⇒ 第一行是被截断的半截,丢掉。
        if (entry.start > 0) continue;
      }
      const stamp = LINE_TIMESTAMP_RE.exec(line);
      if (stamp) lastMs = Date.parse(stamp[1]!);
      if (lastMs !== undefined) {
        if (fromMs !== undefined && lastMs < fromMs) continue;
        if (toMs !== undefined && lastMs > toMs) continue;
      }
      const chunk = Buffer.from(`${line}\n`, 'utf8');
      if (written + chunk.byteLength > maxBytes) {
        rl.close();
        stream.destroy();
        return;
      }
      written += chunk.byteLength;
      yield chunk;
    }
  }
}
