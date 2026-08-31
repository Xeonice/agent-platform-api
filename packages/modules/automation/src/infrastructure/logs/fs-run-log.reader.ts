import { open, stat } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import type { RunLogReader, RunLogSlice } from '../../domain/ports/run-log-reader.port';

const EMPTY: RunLogSlice = { content: '', offset: 0, totalBytes: 0, eof: true };

/**
 * 按字节区间读一份 Task 日志（03 §8.6 的查询半边）。
 *
 * ⚠️ **不整文件读进内存**：上限是 30MB（I-AUR-4），而这个端点的默认窗口是 64KB。
 * `readFile` 之后再切片会让一次「看最后 64KB」把 30MB 读进堆里 —— 在一台同时跑着几个
 * 沙箱的机器上，那是能被一个刷新按钮打垮的东西。
 *
 * ⚠️ **区间可能切在多字节字符中间**，所以用 `TextDecoder` 的流式模式（`stream:true`）
 * 收尾：切碎的那几个字节被丢掉，而不是变成一个 U+FFFD 替换字符插在正文里。
 */
@Injectable()
export class FsRunLogReader implements RunLogReader {
  private readonly logger = new Logger('FsRunLogReader');

  async read(path: string, offset: number | undefined, limit: number): Promise<RunLogSlice> {
    let totalBytes: number;
    try {
      totalBytes = (await stat(path)).size;
    } catch {
      // 文件被清理掉了（保留期到期、或人手动删了 data/）。空片而不是抛：
      // run 记录还在，正文没了是一个可以说清楚的事实，500 不是。
      this.logger.debug(`run log ${path} is gone`);
      return EMPTY;
    }
    if (totalBytes === 0) return EMPTY;

    // offset 缺席 ⇒ 回末尾 limit 字节（03 §8.6 的默认口径）
    const start =
      offset === undefined ? Math.max(0, totalBytes - limit) : clamp(offset, 0, totalBytes);
    const length = Math.min(limit, totalBytes - start);
    if (length <= 0) return { content: '', offset: start, totalBytes, eof: true };

    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      const decoder = new TextDecoder('utf-8');
      const content = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      return { content, offset: start, totalBytes, eof: start + bytesRead >= totalBytes };
    } finally {
      await handle.close();
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(v), min), max);
}
