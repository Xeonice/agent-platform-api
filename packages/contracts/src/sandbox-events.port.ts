import type { SandboxWsEvent } from './ws-protocol';

/**
 * Cross-context broadcaster port (docs/backend/26 §10, shared/10 §7.4). The
 * `sandbox` context projects its domain events into `SandboxWsEvent`s and pushes
 * them through this port WITHOUT knowing about socket.io; the `/events` gateway
 * (composition root) implements it and fans out to every connected client. Living
 * in `contracts` keeps both sides boundaries-clean.
 *
 * Single-tenant MVP: no per-user filtering — `broadcast` reaches all sockets.
 */
export interface SandboxEventBroadcaster {
  broadcast(event: SandboxWsEvent): void;
}

export const SANDBOX_EVENT_BROADCASTER = Symbol('SandboxEventBroadcaster');
