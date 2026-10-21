export interface TerminalBookmark {
  terminalIdentity: string;
  sandboxId: string;
  kind: 'agent' | 'shell' | 'runtime';
  /** Only the authenticated server resolves this private session identifier. */
  privateSessionId: string;
  runtimeId?: string;
  runtimeIdentity?: string;
}
export interface TerminalBookmarks {
  ensure(
    sandboxId: string,
    kind: TerminalBookmark['kind'],
    privateSessionId: string,
    runtimeId?: string,
  ): Promise<TerminalBookmark>;
  resolve(sandboxId: string, terminalIdentity: string): Promise<TerminalBookmark | null>;
  confirm(sandboxId: string, terminalIdentity: string, runtimeIdentity: string): Promise<boolean>;
  markCloseRequested?(sandboxId: string, privateSessionId: string): Promise<void>;
}
export const TERMINAL_BOOKMARKS = Symbol('TerminalBookmarks');
