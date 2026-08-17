export type TerminalSessionStatus = 'open' | 'closed';

/**
 * Terminal session (docs/backend/06). `socketSessionKey` is SERVER-generated
 * (audit P2-9) and is the ONLY session-ownership credential — it must never be
 * client-chosen. It is not persisted in S1 (in-memory gateway state).
 */
export interface TerminalSession {
  readonly id: string;
  readonly sandboxId: string;
  readonly socketSessionKey: string;
  readonly execRef: string;
  status: TerminalSessionStatus;
}
