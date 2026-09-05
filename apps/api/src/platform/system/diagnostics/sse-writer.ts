import type { DiagnoseServerFrame, ProvisionServerFrame } from '@platform/contracts';
import { SSE_DIAGNOSE_SCHEMA_HASH } from '@platform/contracts';

/** 只用到 express `Response` 的这几样 —— 为几个 header 引入 `express` 类型依赖不划算。 */
export interface SseResponse {
  setHeader(name: string, value: string): unknown;
  flushHeaders?(): void;
  write(chunk: string): boolean;
  end(): unknown;
  on(event: 'close', listener: () => void): unknown;
  writableEnded: boolean;
}

/**
 * SSE 写出口（02 §5.3）。**一处写 header、一处写帧**，这是它存在的全部理由 —— 手抄
 * `text/event-stream` 那四个 header 的地方一多，漏掉 `X-Accel-Buffering` 的那一份就会
 * 在装了 nginx 的部署上「什么都不流，最后一次性全出来」，而本机永远复现不了。
 */
/**
 * 这个写出口服务的两条流。
 *
 * ⚠️ **写成闭集联合而不是 `{ event: string }`**：`event` 是消费方的判别键，放开成 string
 * 就等于允许新增一条前端没有分支的流 —— 而那种缺失是静默的（掉进 default 分支，
 * 界面上什么都不发生）。加一条流就要在这里显式登记一次。
 */
export type SseFrame = DiagnoseServerFrame | ProvisionServerFrame;

export class SseWriter {
  constructor(private readonly res: SseResponse) {}

  open(): void {
    this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // 逐项流式的前提：任何一层缓存都不许把它攒起来。
    this.res.setHeader('Cache-Control', 'no-cache, no-transform');
    this.res.setHeader('Connection', 'keep-alive');
    // ⚠️ nginx 默认会缓冲上游响应，于是 SSE 变成「全部跑完一次性到达」—— 逐项出结果
    //    这个唯一的产品要求当场失效，而且只在生产上失效。
    this.res.setHeader('X-Accel-Buffering', 'no');
    // 帧形状的版本。⚠️ 它是**告知**不是门：因版本不匹配拒绝一次只读诊断，等于在最需要
    //    它的时候把它关掉（见 `SSE_DIAGNOSE_SCHEMA_HASH` 的注释）。
    this.res.setHeader('X-Schema-Hash', SSE_DIAGNOSE_SCHEMA_HASH);
    this.res.flushHeaders?.();
  }

  /**
   * 一帧。
   *
   * ⚠️ **`event:` 行与 `data` 里的 `event` 字段是刻意重复的**：用 `EventSource` 的消费方
   * 读前者，用 `fetch` + `ReadableStream`（要带 POST body，`EventSource` 不支持）的消费方
   * 读后者。少任何一个，就有一条真实存在的消费路径拿不到判别键。
   *
   * ⚠️ `JSON.stringify` 的结果里不会有裸换行（会被转义成 `\n`），所以一帧一行是安全的
   * —— 否则多行 payload 需要每行前缀 `data: `，而漏掉那一步的表现是「解析器安静地只
   * 看到第一行」。
   */
  send(frame: SseFrame): void {
    if (this.res.writableEnded) return;
    this.res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame)}\n\n`);
  }

  close(): void {
    if (!this.res.writableEnded) this.res.end();
  }

  /** 客户端断开 —— 触发中止剩余检查（02 §5.3：诊断只读，中止无副作用）。 */
  onClose(fn: () => void): void {
    this.res.on('close', fn);
  }
}
