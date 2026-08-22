import type { RuntimeInstallStatus, SandboxStatus } from './schemas/enums';

/**
 * WS frame contract — SYNC WITH shared/10 §7.4 (the single canonical definition).
 *
 * Two channels, two DISCRIMINATOR fields ON PURPOSE (10 §7.4):
 *   - /terminal frames discriminate on `type` (a byte-stream frame protocol)
 *   - /events events discriminate on `event` (business projections)
 * so neither is ever mis-parsed as the other.
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
  'runtime.install_progress{sandboxId,runtime,status,versionDetected?,errorCode?}';

/**
 * X-Schema-Hash the two repos compare at the /terminal handshake (shared/14 §2.5).
 *
 * S1: a PINNED shared literal (must byte-equal the frontend's hardcoded value),
 * so the handshake actually agrees — a runtime sha256 here could never match a
 * hardcoded string on the other side. The real frame-schema codegen hash +
 * cross-repo sync is deferred to the shared/14 §2.4 X-Schema-Hash toolchain.
 */
export const WS_SCHEMA_HASH = 'sb-terminal-v1';

export const X_SCHEMA_HASH_HEADER = 'x-schema-hash';
