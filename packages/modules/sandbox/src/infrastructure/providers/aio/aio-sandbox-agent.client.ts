import type {
  FileEntry,
  JobChunk,
  JobCursor,
  JobSpec,
  ProcessSpec,
  ProcessStream,
} from '@platform/contracts';
import { AioAgentHttp } from './aio-http';
import { exec, openTerminal } from './aio-guest-shell';
import { listFiles, openFileStream, readFileBytes, writeFileContent } from './aio-files';
import { killJob, readJob, releaseJob, startJob } from './aio-jobs';

/**
 * Data-plane client for the in-sandbox AIO Sandbox agent (SANDBOX-RUNTIME-DECISIONS
 * 决策 A / C). The control plane (`ContainerRuntime`) only manages the sandbox
 * lifecycle; exec/pty/files/jobs all go through the agent's own HTTP+WS API on
 * `:8080` INSIDE the sandbox. This client translates the AIO wire protocol ↔ the
 * neutral contract types so the gateway stays provider-agnostic (**translation lives
 * in the provider, not in the gateway**).
 *
 * ══ 2026-08-29：这个文件从 1545 行变成一层薄外观 ═══════════════════════════════
 *
 * 它曾经是一个类里装下**全部**数据面：pty、exec、作业面、文件面、HTTP 传输、信封解析、
 * job id 编解码。boxlite 那侧早就按面切开了，于是两档看起来像**结构不同的东西** ——
 * 而它们其实是同一份契约的两个实现。切开之后一一对应：
 *
 * | aio | boxlite | 管什么 |
 * |---|---|---|
 * | `aio-http.ts` | （native SDK，无此层） | 传输：一个 origin + 一把 key + 拆信封 |
 * | `aio-guest-shell.ts` | `boxlite-guest-shell.ts` | 在沙箱里跑一条命令 / 开一个 pty |
 * | `aio-process.stream.ts` | `boxlite-process.stream.ts` | 翻成中立 `ProcessStream` |
 * | `aio-files.ts` | `boxlite-files.ts` | 文件面 |
 * | `aio-jobs.ts` | `boxlite-jobs.ts` | 作业面 |
 *
 * ⚠️ **拆之前先给「只在重启后才炸」的那两条不变量补了能红的测试**（`startJob` 的三步
 * 顺序、ws 只 attach 不 create）。在那之前它们只活在注释里 —— 实测四种改法（提前连
 * socket / ws 不带 session_id / ws 带新 session_id / 先 exec 后建 session）**一条都
 * 不会红**。没有测试兜底的纯搬运，正是这类 bug 的温床。
 *
 * ⚠️ **这一层不做任何决定。** 它只持有 `AioAgentHttp` 并转发——所有语义都在上表那五个
 * 文件里。往这里加逻辑，就是在把刚拆开的东西重新粘回去。
 */
export class AioSandboxAgentClient {
  private readonly http: AioAgentHttp;

  constructor(baseHttpUrl: string, apiKey?: string) {
    this.http = new AioAgentHttp(baseHttpUrl, apiKey);
  }

  // ── shell 面（`SandboxProvider.spawn`）─────────────────────────────────────
  openTerminal(cols: number, rows: number, cmd?: string[]): Promise<ProcessStream> {
    return openTerminal(this.http, cols, rows, cmd);
  }

  exec(spec: ProcessSpec): Promise<ProcessStream> {
    return exec(this.http, spec);
  }

  // ── 作业面（`SandboxJobs`, 04 §2.6）───────────────────────────────────────
  startJob(spec: JobSpec): Promise<string> {
    return startJob(this.http, spec);
  }

  readJob(jobId: string, cursor?: JobCursor, waitMs?: number): Promise<JobChunk> {
    return readJob(this.http, jobId, cursor, waitMs);
  }

  killJob(jobId: string, signal?: NodeJS.Signals, graceMs?: number): Promise<void> {
    return killJob(this.http, jobId, signal, graceMs);
  }

  releaseJob(jobId: string): Promise<void> {
    return releaseJob(this.http, jobId);
  }

  // ── 文件面（`SandboxFiles`, 04 §2.6）──────────────────────────────────────
  readFileBytes(path: string): Promise<Buffer | null> {
    return readFileBytes(this.http, path);
  }

  openFileStream(path: string): Promise<NodeJS.ReadableStream | null> {
    return openFileStream(this.http, path);
  }

  writeFileContent(path: string, content: string | Buffer): Promise<void> {
    return writeFileContent(this.http, path, content);
  }

  listFiles(
    path: string,
    opts?: { recursive?: boolean; maxEntries?: number },
  ): Promise<FileEntry[]> {
    return listFiles(this.http, path, opts);
  }
}

/**
 * ⚠️ **这些 re-export 不是图省事，是为了让「拆分」与「改接口」是两件事。**
 * provider、数据面适配器和一批单测都从这个模块名 import 这些符号；把它们的落点和
 * 模块名一起换掉，diff 里就再也分不出「哪些改动是搬运、哪些是行为变化」——而这轮改动
 * 的全部价值恰恰在于**它是纯搬运**。新代码请直接从各自的文件 import。
 */
export { KILL_GRACE_MS, PTY_KILL_SETTLE_MS, toAgentSignal } from './aio-process.stream';
export type { AgentSignal, PtySocket } from './aio-process.stream';
export { AioWsProcessStream } from './aio-process.stream';
export { PTY_READY_GRACE_MS, PTY_READY_QUIET_MS, wrapWithStdin } from './aio-guest-shell';
export { shellQuote } from './aio-http';
export { closeAllJobStreams } from './aio-jobs';
