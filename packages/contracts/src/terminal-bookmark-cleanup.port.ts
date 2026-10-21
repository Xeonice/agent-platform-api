import type { Tx } from '@platform/shared-kernel';

/** A committed, explicit sandbox/project deletion owns the transaction;
 * the terminal context owns its non-credential reconnect bookmarks. */
export interface TerminalBookmarkCleanup {
  deleteForSandboxSync(tx: Tx, sandboxId: string): void;
}
export const TERMINAL_BOOKMARK_CLEANUP = Symbol('TerminalBookmarkCleanup');
