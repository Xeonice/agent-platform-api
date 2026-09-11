import type { RuntimeInstallStatus, SandboxStatus } from './schemas/enums';
import type { TaskStatus } from './schemas/task.schema';
import type { RuntimeEvent } from './runtime-adapter.contract';

/**
 * WS frame contract — SYNC WITH shared/10 §7.4 (the single canonical definition).
 *
 * Three channels, two DISCRIMINATOR fields ON PURPOSE (10 §7.4):
 *   - /terminal frames discriminate on `type` (a byte-stream frame protocol)
 *   - /events events discriminate on `event` (business projections)
 *   - /tasks frames discriminate on `type` (a stream, like /terminal — NOT projections)
 * so none is ever mis-parsed as another.
 *
 * `data` is PLAIN STRING, not base64 (xterm writes it directly). The `exit`
 * frame is retained so ProcessStream.onExit has an uplink (10 §7.4 decision).
 */

// ── /terminal channel (URL query carries socketSessionKey, server-generated) ──
export type TerminalClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }
  /**
   * 「我**主动**关掉了这个用户终端标签，把它那个 tmux 会话销毁掉」（06 §5）。
   *
   * ⚠️ **它存在的唯一理由，是把「关标签」和「断连」分开。** 断连（刷新、网络抖动、
   * LRU 淘汰）一律只是 detach —— 这条纪律对用户自己开的 shell 与对 agent 会话同样成立：
   * 那个标签里可能正跑着 `pnpm build`，刷一下页面就把它打断是不可接受的。所以销毁只能
   * 由一个**显式动作**触发，`handleDisconnect` 里永远不许有 kill。
   *
   * ⛔ **它永远碰不到 agent 会话**：载荷是 `shellId`（32 位十六进制，服务端生成），
   * 服务端据它拼出 `platform-shell-<shellId>` —— `platform-agent` 不是这个形状，
   * 拼不出来（`shellSessionName()` 对不合形状的 id 直接抛）。这不是「记得别 kill 它」，
   * 是**拼不出那个名字**。
   *
   * ⚠️ 载荷带 `shellId` 而不是「关掉我这条连接对应的那个」：被 LRU 淘汰的标签**没有连接**
   * （08 §5.2），而用户照样能点它的 [×]。带上 id 之后任何一条连到**同一个沙箱**的
   * `/terminal` 连接都能代发这次销毁，于是"淘汰过的标签关不掉、tmux 会话就此成为
   * 看不见的孤儿"这条路被堵死。
   */
  | { type: 'close_shell'; shellId: string };

export type TerminalServerFrame =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'pong' }
  /**
   * 开会话首帧。`socketSessionKey` 是重连凭据（06 §6.2，服务端生成）。
   *
   * `shellId` **只在用户自己开的终端标签上出现**（握手带了 `kind=shell`）：它是这个标签
   * 背后那个 `platform-shell-<shellId>` tmux 会话的名字尾段，同样 128-bit、同样服务端
   * 生成（与 `socketSessionKey` 同一条纪律，审计 P2-9）。
   *
   * ⛔ **为什么不让客户端自己起名**：这个值会原样进 `tmux -s <name>` 的 argv —— 客户端
   * 可指定就等于把 tmux 的会话命名面（以及 argv）交给浏览器。服务端生成 + 收回时按形状
   * 校验（`TERMINAL_SHELL_ID_RE`），是唯一不需要信任客户端的形状。
   *
   * ⚠️ agent 标签**没有**这个字段（缺席 = 「这条连接连的是 `platform-agent`」），
   * 而不是给一个空串 —— 「没有」和「有一个空的」在前端会走进不同分支。
   */
  | { type: 'session'; socketSessionKey: string; shellId?: string }
  /**
   * 这个 sandbox 下**已经存在**的用户终端会话清单（06 §5.5）。刷新页面之后，前端凭它
   * 把标签栏重建回来 —— 否则那些 tmux 会话还活着、界面上却没有了，成了只能等沙箱回收
   * 的孤儿。而「看不见但还活着比关掉更糟」正是 `close_shell` 那条设计的立论。
   *
   * ⚠️ **三态，一个都不能少**（`null` 不是凑数）：
   *   · `[...]` —— 确认有这些（按 tmux `session_created` **升序**，顺序是载荷的一部分：
   *     前端按它编「终端 1..n」）；
   *   · `[]`    —— 确认**没有**（tmux 答了，就是一个都没有）；
   *   · `null`  —— **问不出来**（tmux server 不在、沙箱内 agent 不通）。
   * ⛔ 第三态不许在前端渲染成「你没有开过终端」，也不许被静默吞掉 —— 那是把「不知道」
   *   说成「没有」。⛔ 也不许用「不发这一帧」来表示它：那与「还没答」无从区分。
   *
   * ⚠️ **只在 `kind=agent` 那条连接上推**，见 `pushShellInventory` 的注释。
   */
  | { type: 'shells'; shells: TerminalShellSummary[] | null };

/**
 * `?kind=` 握手参数：这条 `/terminal` 连接要连**哪一个** tmux 会话（06 §5）。
 *
 * ⚠️ 这个参数之所以必须存在，是 tmux 的语义决定的（2026-09-11 实测，tmux 3.7b）：
 * 两个客户端 attach **同一个** session 时，`list-panes` 只有**一个** pane —— 它们看到的是
 * 同一块屏幕的镜像，共享同一个 window/pane。所以在 `kind` 之前，「开第二个终端标签」
 * 得到的是 agent 那一屏的副本，而不是第二个终端。⇒ 第二个标签必须是**另一个 session**。
 *
 *   · `agent` （缺省）—— attach `platform-agent`，即 provision 在 `starting` 段起好的那个
 *     agent 会话（裁决 D-15）。⛔ 这条路不许变，也不许因为断连而销毁。
 *   · `shell` —— 用户自己开的独立 shell：`tmux new-session -A -s platform-shell-<shellId>`。
 *     不带 `shellId` = 新开一个（服务端生成 id 并在首帧回传）；带 = 接回那一个。
 *   · `runtime` —— 用户自己开的 **agent CLI 标签**（06 §5.6），必须同时带
 *     `?runtimeId=`。机制上与 `shell` 完全一样（独立会话、自己的 shellId、可关），
 *     只是跑的命令是 `buildAttachCommand()` 而不是 `$SHELL`。
 *
 * ⚠️ **`agent` 与 `runtime` 是两个不同的东西，别混。** `agent` 指的是**这个 Task 自己**
 * 那个 `platform-agent` 会话（provision 起的、关不掉、断连不销毁）；`runtime` 是用户
 * 随手开的一个 CLI 标签，跟任务没有关系，可关、可销毁。
 * ⛔ 它也**不是**「发起一个任务」：任务走 `buildStartCommand` + 建 AgentTask（产物 /
 * 审计 / 超时 / 可取消），标签一样都没有。
 */
export type TerminalSessionKind = 'agent' | 'shell' | 'runtime';

/**
 * 清单里的一条用户终端：会话 id + **里面跑的是哪个 agent CLI**（06 §5.6）。
 *
 * ⚠️ `runtimeId` 缺席 = 这是个**纯终端**标签（或者沙箱里的 tmux 老到读不出用户选项，
 * 那时前端回落成「终端 N」—— 与本切片之前的行为一样，不会更坏）。
 * ⛔ 缺席不许被当成某个默认 runtime：那会让一个纯终端标签顶着「Codex」的名字。
 */
export interface TerminalShellSummary {
  shellId: string;
  runtimeId?: string;
}

/**
 * 用户终端标签的 tmux 会话 id 形状：**32 位小写十六进制**（= 128-bit，`randomBytes(16)`）。
 *
 * ⚠️ 它同时是**注入面的闸门**。这个值唯一的去处是 `tmux ... -s platform-shell-<id>` 的
 * argv，而 argv 里能放什么完全由这条正则说了算 —— 十六进制字符集里没有引号、空格、
 * 分号、`$`，所以形状过了就不可能有第二条命令。⛔ 因此**不许**放宽成 `^[\w-]+$` 之类
 * 「看起来也挺安全」的形状：安全性来自字符集，不来自「客户端不会乱传」。
 *
 * ⚠️ 领域层（`tmux-command.policy.ts`）另有一份同样的正则，因为领域不许 import
 * contracts（23 §4.5）。两份由 `shell-session.spec.ts` 逐字钉在一起。
 */
export const TERMINAL_SHELL_ID_RE = /^[0-9a-f]{32}$/;

/**
 * `?runtimeId=` 的形状。runtime id 是**开放注册表**的键（04 §8），所以这里只挡住明显
 * 不是 id 的东西（空、带引号/空格/分号），⛔ **不收窄成已注册的那几个** —— 那会让
 * 第三方注册的 runtime 在握手层就被拒。
 *
 * ⚠️ 真正的判据是「这个沙箱里有没有它」，那要读沙箱行、是异步的，落在 `openSession`。
 * 这一条只是 argv 侧的形状闸门（它会进 tmux 负载里的 `set-option` 参数）。
 */
export const RUNTIME_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 这个字符串能不能当 shellId 用（形状校验，见 `TERMINAL_SHELL_ID_RE`）。 */
export function isTerminalShellId(v: unknown): v is string {
  return typeof v === 'string' && TERMINAL_SHELL_ID_RE.test(v);
}

// ── /events channel (discriminator: event) ──
// SYNC WITH shared/10 §7.4 (canonical union, 8 variants). `status` is the
// SandboxStatus enum (NOT a bare string). S1 PRODUCES only sandbox.created /
// sandbox.status_changed / sandbox.removed; waiting_input (S4), clone_progress
// (S2) and runtime-auth.status_changed (S3) are defined here but not yet emitted.
export type SandboxWsEvent =
  | { event: 'sandbox.created'; sandboxId: string; projectId: string }
  /**
   * `errorCode` is present only on `status:'failed'` — the code (never a sentence)
   * behind the failure, so the frontend can render the P22 §1 人话 immediately instead
   * of a generic fallback. Async provisioning means there is no HTTP response left to
   * carry it (the caller holds its 202 already), and `runtime.install_progress` only
   * covers install failures — `IMAGE_CONTRACT_VIOLATION` has no other live channel.
   * The same code is also persisted on `SandboxDto.failureCode`, because a WS event
   * missed is gone and a refresh must still show the reason.
   */
  | {
      event: 'sandbox.status_changed';
      sandboxId: string;
      status: SandboxStatus;
      phase?: string;
      errorCode?: string;
    }
  | { event: 'sandbox.removed'; sandboxId: string }
  | { event: 'sandbox.waiting_input'; sandboxId: string; waiting: boolean; sessionId?: string }
  | {
      event: 'project.clone_progress';
      projectId: string;
      phase: 'cloning' | 'slow' | 'done' | 'failed';
      /** git 阶段名（03 §7.2★）。`cloning` 之外的 phase 不带它。 */
      stage?: 'enumerating' | 'counting' | 'compressing' | 'receiving' | 'resolving' | 'checkout';
      percent?: number;
      /** `(527/26348)` —— git 唯一诚实的分母（`totalBytes` 是幽灵字段，已删）。 */
      objectsDone?: number;
      objectsTotal?: number;
      receivedBytes?: number;
      /** 接收速率；卡住时它先归零，比百分比停住更早暴露。 */
      bytesPerSecond?: number;
      errorCode?: string;
    }
  | { event: 'runtime-auth.status_changed'; runtime: string }
  /**
   * Install progress of the runtime CLI inside a sandbox's `starting` 段 (03 §4.3 ③).
   *
   * WHY A SEVENTH EVENT RATHER THAN REUSING `sandbox.status_changed` (T-3): while the
   * CLI installs, `sandbox.status` is CONSTANT at `starting` — measured at 753s for a
   * cold `claude-code` (04 §3 ★1). Folding progress into `status_changed` would emit a
   * run of "state changes" where no state changed, breaking that event's documented
   * "EVERY state-machine transition" semantics and the frontend's patch behaviour.
   * It DOES go through the Outbox (its源 event does), because a dropped frame would
   * leave the progress card pinned on stale copy forever.
   */
  | {
      event: 'runtime.install_progress';
      sandboxId: string;
      runtime: string;
      status: RuntimeInstallStatus;
      versionDetected?: string;
      errorCode?: string;
    }
  /**
   * The two BOUNDARIES of step ① `provider.start()` (03 §4.3) — the one stretch of
   * the `starting` 段 no other event covers.
   *
   * WHY AN EIGHTH EVENT RATHER THAN `sandbox.status_changed` (with its `phase?`): the
   * same argument as `runtime.install_progress` above, and it bites harder here.
   * `sandbox.status` is CONSTANT at `starting` for the whole call — measured at
   * **190529ms** for a cold 13GB `platform/sandbox:v2`, because the micro-VM is LAZY:
   * `runtime.create()` returns in ~4ms and the image is pulled and unpacked into a
   * rootfs on the FIRST exec. Folding that into `status_changed` would emit a run of
   * "state changes" where no state changed; the `phase?` field on that event is not an
   * exemption from its documented "EVERY state-machine transition" semantics, it would
   * just hide the violation from the type checker.
   *
   * ⚠️ WHAT IS DELIBERATELY **NOT** ON THIS FRAME — both omissions are the point.
   * ① **No percentage and no ETA.** `provider.start()` is a single `await`: the platform
   *    is handed 「开始」 and 「结束」 and nothing in between — there is no 40%/80%
   *    callback to read, so any number here would be invented. This repo has already
   *    deleted one invented denominator for exactly that reason (see
   *    `project.clone_progress`: `totalBytes` was a 「幽灵字段，已删」).
   * ② **No elapsed milliseconds.** The frontend knows the instant it received
   *    `status_changed → starting`; counting up from there costs it one `setInterval`
   *    and needs no field, no frame and no clock-skew handling. An `elapsedMs` here
   *    would be a field whose only reader can already compute it alone.
   *
   * ⇒ what IS here is only what the platform knows and the browser CANNOT: whether
   * this machine already holds the image's bits (`SandboxProvider.imageStaged`).
   * `imageStaged:false` is the whole difference between 「几秒」 and 「几分钟」, and it is
   * the one fact that turns 「卡住了」 into 「首次用这个镜像，正在准备」.
   *
   * ⚠️ IT IS **ABSENT**, NOT `false`, WHEN THE PROVIDER CANNOT SAY. 「不知道」 and
   * 「本机没有这份镜像」 are different claims, and only one of them may be put in
   * front of a waiting user as a reason for a multi-minute wait.
   *
   * NOT Outbox-backed, deliberately — the opposite call from `runtime.install_progress`
   * one variant up, for a reason specific to this frame: a dropped `starting` only
   * degrades the copy to the generic wording for the rest of THIS wait, and a dropped
   * `ready` is overwritten by the `status_changed` that always follows. Install
   * progress rides the Outbox because nothing follows it — a dropped frame there pins
   * the card on stale copy forever.
   */
  | {
      event: 'sandbox.instance_progress';
      sandboxId: string;
      /** `starting` = 即将调 `provider.start()`；`ready` = 它返回了（实例能跑命令了）。 */
      phase: 'starting' | 'ready';
      /** 只在 `phase:'starting'` 且 provider 答得上时出现；缺席 = 「不知道」。 */
      imageStaged?: boolean;
    };

// ── /tasks channel (S6 无头 Task 输出流;discriminator: type) ────────────────
/**
 * WHY A THIRD NAMESPACE RATHER THAN ONE MORE `/events` EVENT: `/events` frames are
 * business projections and ride the Outbox for at-least-once delivery (13 §2.8). Task
 * output is a high-volume BYTE-DERIVED stream — a long task emits thousands of events.
 * Putting it through the Outbox would be pure write amplification for data that already
 * has a durable home (the platform's own JSONL log), and would drown the projection
 * channel that the whole UI depends on. Same reasoning that keeps `/terminal` separate.
 *
 * ⚠️ THE CURSOR HERE IS **NOT** THE SANDBOX-SIDE CURSOR. `JobCursor` (04 §2.6) is an
 * opaque provider-defined byte offset; it stops at the platform boundary. What crosses
 * to the frontend is `seq` — a plain monotonic per-task counter the platform assigns as
 * it persists each event. So "resume after a refresh" is `fromSeq`, and the frontend
 * never learns that a byte offset exists. Two cursors, two layers, on purpose.
 */
export type TaskClientFrame =
  /**
   * ⚠️ `fromSeq` IS EXCLUSIVE: "I already hold everything up to and including N — send
   * me what comes AFTER it." Omitting it means "send everything from the start".
   *
   * Stated because the boundary is not guessable and both readings are plausible: an
   * inclusive reading re-delivers the last event the client already rendered, and a
   * client that pointed `fromSeq` at its own high-water mark would see a duplicate on
   * every reconnect. The matching consequence is that `AgentTaskDto.lastSeq` is NOT a
   * resume point (see task.schema.ts) — it is an upper bound to compare against.
   */
  | { type: 'subscribe'; taskId: string; fromSeq?: number }
  | { type: 'unsubscribe'; taskId: string }
  | { type: 'ping' };

export type TaskServerFrame =
  /**
   * One parsed `RuntimeEvent` (04 §3). `seq` is dense and monotonic per task: on
   * subscribe the platform REPLAYS from `fromSeq` out of its own persisted log, then
   * switches to live push. A gap in `seq` is a bug, not something to tolerate.
   */
  | { type: 'event'; taskId: string; seq: number; event: RuntimeEvent }
  /**
   * Replay finished; everything after this frame is live.
   *
   * `seq` is the highest event delivered so far (= `fromSeq` when the replay was empty).
   *
   * ⚠️ `firstSeq` IS WHAT MAKES A TRUNCATED REPLAY DETECTABLE. It is the seq of the
   * FIRST event this replay actually sent, or `seq + 1` when it sent none (an empty
   * range). Without it a subscriber can only notice a gap in the MIDDLE of the stream;
   * a head that was dropped — because the platform could not replay that far back —
   * looks exactly like a stream that legitimately starts there. The subscriber compares
   * `firstSeq` against `fromSeq + 1`: greater ⇒ the beginning is missing, and it must
   * say so rather than render a partial transcript as if it were whole.
   */
  | { type: 'caught_up'; taskId: string; firstSeq: number; seq: number }
  /**
   * Terminal state. `exitCode` MAY be absent — a signal-killed process has none.
   *
   * ⚠️ IT IS ALSO SENT TO A LATE SUBSCRIBER. Subscribing to an ALREADY-finished task
   * must still yield an `exit` frame after the replay: the live one fired long ago, and
   * without a re-send the subscriber would have to reconstruct the outcome from a REST
   * DTO — i.e. two sources of truth for the same fact, one of which is a stream.
   */
  | { type: 'exit'; taskId: string; status: TaskStatus; exitCode?: number }
  /** Always a CODE, never a sentence — the frontend renders the 人话 (P22 §1). */
  | { type: 'error'; taskId: string; code: string }
  | { type: 'pong' };

/**
 * Canonical, order-stable description of the frame shapes. Kept as documentation
 * of what the pinned hash below stands for; changing a frame shape should bump
 * WS_SCHEMA_HASH in lockstep with the frontend.
 */
export const WS_PROTOCOL_CANONICAL =
  'terminal.client:input{data},resize{cols,rows},ping,close_shell{shellId}|' +
  'terminal.server:data{data},exit{code},pong,session{socketSessionKey,shellId?},' +
  'shells{shells[shellId,runtimeId?]}|' +
  'events:sandbox.created{sandboxId,projectId},sandbox.status_changed{sandboxId,status,phase?,errorCode?},' +
  'sandbox.removed{sandboxId},sandbox.waiting_input{sandboxId,waiting,sessionId?},' +
  'project.clone_progress{projectId,phase,stage?,percent?,objectsDone?,objectsTotal?,' +
  'receivedBytes?,bytesPerSecond?,errorCode?},' +
  'runtime-auth.status_changed{runtime},' +
  'runtime.install_progress{sandboxId,runtime,status,versionDetected?,errorCode?},' +
  'sandbox.instance_progress{sandboxId,phase,imageStaged?}|' +
  'tasks.client:subscribe{taskId,fromSeq?},unsubscribe{taskId},ping|' +
  'tasks.server:event{taskId,seq,event},caught_up{taskId,firstSeq,seq},' +
  'exit{taskId,status,exitCode?},error{taskId,code},pong';

/**
 * X-Schema-Hash the two repos compare at the /terminal handshake (shared/14 §2.5).
 *
 * S1: a PINNED shared literal (must byte-equal the frontend's hardcoded value),
 * so the handshake actually agrees — a runtime sha256 here could never match a
 * hardcoded string on the other side. The real frame-schema codegen hash +
 * cross-repo sync is deferred to the shared/14 §2.4 X-Schema-Hash toolchain.
 */
export const WS_SCHEMA_HASH = 'sb-terminal-v4';

/**
 * `terminal.server:exit{code}` 里表示"**平台没能附着上**"的哨兵码。
 *
 * ⚠️ 为什么不能复用 `-1`:`-1` 已经有确切含义 —— `ProcessStream.onExit` 收到 `null`
 * (进程被信号杀死、退出码未知)时网关就发 `-1`。一个被 OOM kill 的 agent 与"整个沙箱
 * 已经不在了"会变成**字节级相同**的一帧,而这两件事对用户的下一步完全不同:
 * 前者等结果/看日志,后者只能重新发起任务。
 *
 * 它落在既有帧的既有字段里(`code` 本来就是 number),所以**不动 `WS_PROTOCOL_CANONICAL`、
 * 不用 bump `WS_SCHEMA_HASH`** —— 老客户端把它当一个未知退出码显示,不会崩。
 *
 * ⚠️ 只用于**不可重试**的附着失败。可重试的(`PROVIDER_UNAVAILABLE` 这类,
 * `SandboxProviderError.retryable` 自己会说)**一帧都不发**,让客户端的退避重连
 * 照旧自愈 —— 发了就等于把瞬时故障判成永久故障。
 */
export const TERMINAL_EXIT_ATTACH_FAILED = -2;

/**
 * The `/tasks` handshake's X-Schema-Hash. A SEPARATE pinned literal from
 * `WS_SCHEMA_HASH` because the two channels version independently: a `/tasks` frame
 * change must not invalidate every open terminal, and vice versa. Same discipline —
 * it must byte-equal the value the frontend presents.
 *
 * ⚠️ ON `/tasks` IT IS REQUIRED, NOT OPTIONAL. The gateway refuses a handshake that
 * presents no hash at all, because a check that only fires when the client bothered to
 * send one can only ever catch the careful client — the one that does not need
 * catching. The refusal arrives as a socket.io `connect_error` whose message LEADS with
 * `SCHEMA_MISMATCH:` (and repeats it on `err.data.code`), deliberately using none of the
 * words a client's "is this unauthorized?" matcher looks for: a version drift shown as
 * an auth failure sends the user to unlock something, which cannot fix a version drift.
 *
 * ⏳ It is still a HAND-PINNED literal rather than a hash derived from
 * `WS_PROTOCOL_CANONICAL` — deriving it would produce a value the frontend's own
 * hardcoded literal could never match, so the two must move together by hand until the
 * shared/14 §2.4 codegen toolchain exists. What keeps it honest meanwhile is
 * `ws-protocol.spec.ts`, which pins the hash and the canonical `tasks.*` description
 * TOGETHER: changing a frame shape fails there until the hash is bumped in lockstep.
 */
export const WS_TASKS_SCHEMA_HASH = 'sb-tasks-v1';

export const X_SCHEMA_HASH_HEADER = 'x-schema-hash';

/**
 * How a socket.io handshake is REFUSED — the same three codes on all three namespaces.
 *
 * ⚠️ THE REFUSAL IS PART OF THE WIRE CONTRACT, which is why it lives here and not in
 * one gateway. It is delivered as `connect_error` from socket.io MIDDLEWARE, with the
 * code LEADING the message (`UNAUTHORIZED: …`) and repeated on `err.data.code`; the
 * frontend's shared matcher (`services/ws/socketAuth.ts`) reads exactly those two, in
 * that order, for all three channels.
 *
 * ⚠️ ONLY `UNAUTHORIZED` MAY LOOK LIKE AN AUTH FAILURE. That matcher's last resort is a
 * prose regex — `/unauthor|forbidden|passcode|401|403/i` — so none of those words may
 * appear in a `SCHEMA_MISMATCH` or `SANDBOX_REQUIRED` message. Being mistaken for one
 * pops the unlock dialog, and for a protocol-version drift (or a missing query
 * parameter) that sends the user to do the one thing that cannot possibly help.
 *
 * ⚠️ AND `SANDBOX_REQUIRED` IS DELIBERATELY NOT SPELLED `UNAUTHORIZED`. A handshake that
 * omits `sandboxId` presented a perfectly good passcode; what is missing is ADDRESSING.
 * Reusing `UNAUTHORIZED` would misname the fault AND route the user to a dialog that
 * cannot add a query parameter the client itself failed to send.
 *
 * ── `TERMINAL_TARGET_INVALID`（2026-09，随终端多标签加入，06 §5）────────────────
 * `/terminal` 的握手说不清它要连**哪一个**会话：`?kind=` 不是 `agent`/`shell`，或者
 * `kind=shell` 却带了一个形状不对的 `?shellId=`。它与 `SANDBOX_REQUIRED` 同属**寻址**，
 * 所以同样不许叫成 `UNAUTHORIZED`（那会弹一扇解不了问题的解锁门）。
 *
 * ⛔ **两种不合法都必须响亮地拒，不许兜底**：
 *   · `kind` 认不出而按 agent 处理 ⇒ 用户点「+ 新终端」会安静地拿到 agent 那一屏的镜像
 *     （tmux 多 client attach 同一 session = 同一块屏幕，实测见 `tmux-command.policy.ts`），
 *     他在里面敲的每个字都进了正在跑的 agent，而界面上没有任何异常；
 *   · `shellId` 形状不对而悄悄新开一个 ⇒ 既掩盖了客户端 bug / 参数探测（这个值进
 *     `tmux -s` 的 argv），又会在沙箱里堆出没人认领的 tmux 会话。
 *
 * ⚠️ **这个联合体不要在成员之间插注释**。`docs:check` 的 A5 扫描器认「闭集联合」用的是
 * 一个 400 字符的窗口（`scripts/docs-check.mjs` ④b），注释一插进来声明就超窗 ⇒
 * **整组码悄悄从源码侧集合里消失**，A5 反过来报「文档表有、源码无」。理由写在这段
 * JSDoc 里，成员列表保持干净。
 */
export type WsHandshakeRejection =
  'UNAUTHORIZED' | 'SCHEMA_MISMATCH' | 'SANDBOX_REQUIRED' | 'TERMINAL_TARGET_INVALID';

/**
 * Build the `Error` a gateway hands to socket.io's `next(err)`.
 *
 * `err.data` is the structured half: socket.io copies it to the client verbatim, so a
 * client never has to parse prose. The message still LEADS with the code because a
 * client that only has the message must still be able to tell the three apart.
 */
export function wsHandshakeError(
  code: WsHandshakeRejection,
  detail: string,
): Error & { data: { code: WsHandshakeRejection } } {
  const err = new Error(`${code}: ${detail}`) as Error & {
    data: { code: WsHandshakeRejection };
  };
  err.data = { code };
  return err;
}
