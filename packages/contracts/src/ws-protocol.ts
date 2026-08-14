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
export type SandboxWsEvent =
  | { event: 'sandbox.created'; sandboxId: string; projectId: string }
  | { event: 'sandbox.status_changed'; sandboxId: string; status: string; phase?: string }
  | { event: 'sandbox.removed'; sandboxId: string }
  | { event: 'sandbox.waiting_input'; sandboxId: string; waiting: boolean; sessionId?: string };

/**
 * Canonical, order-stable description of the frame shapes. Kept as documentation
 * of what the pinned hash below stands for; changing a frame shape should bump
 * WS_SCHEMA_HASH in lockstep with the frontend.
 */
export const WS_PROTOCOL_CANONICAL =
  'terminal.client:input{data},resize{cols,rows},ping|' +
  'terminal.server:data{data},exit{code},pong,session{socketSessionKey}|' +
  'events:sandbox.created{sandboxId,projectId},sandbox.status_changed{sandboxId,status,phase?},' +
  'sandbox.removed{sandboxId},sandbox.waiting_input{sandboxId,waiting,sessionId?}';

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
