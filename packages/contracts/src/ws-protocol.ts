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
  | { type: 'ping' };

export type TerminalServerFrame =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'pong' }
  | { type: 'session'; socketSessionKey: string };

// ── /events channel (discriminator: event) ──
// SYNC WITH shared/10 §7.4 (canonical union, 7 variants). `status` is the
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
      receivedBytes?: number;
      totalBytes?: number;
      percent?: number;
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
    };

// ── /tasks channel (S6 无头 Task 输出流;discriminator: type) ────────────────
/**
 * WHY A THIRD NAMESPACE RATHER THAN AN EIGHTH `/events` EVENT: `/events` frames are
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
  'terminal.client:input{data},resize{cols,rows},ping|' +
  'terminal.server:data{data},exit{code},pong,session{socketSessionKey}|' +
  'events:sandbox.created{sandboxId,projectId},sandbox.status_changed{sandboxId,status,phase?,errorCode?},' +
  'sandbox.removed{sandboxId},sandbox.waiting_input{sandboxId,waiting,sessionId?},' +
  'project.clone_progress{projectId,phase,receivedBytes?,totalBytes?,percent?,errorCode?},' +
  'runtime-auth.status_changed{runtime},' +
  'runtime.install_progress{sandboxId,runtime,status,versionDetected?,errorCode?}|' +
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
export const WS_SCHEMA_HASH = 'sb-terminal-v1';

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
 */
export type WsHandshakeRejection = 'UNAUTHORIZED' | 'SCHEMA_MISMATCH' | 'SANDBOX_REQUIRED';

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
