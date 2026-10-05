/** Terminal-owned in-memory observations. The external contract exposes queries only. */
export interface WaitingInputObserver {
  attach(sessionId: string, sandboxId: string): void;
  output(sessionId: string, data: string): void;
  input(sessionId: string): void;
  detach(sessionId: string): void;
  isWaiting(sandboxId: string): boolean;
  filterWaiting(sandboxIds: string[]): Set<string>;
}

export interface WaitingInputSettings {
  silenceSec: number;
  promptPatterns: string[];
}

export const WAITING_INPUT_OBSERVER = Symbol('WaitingInputObserver');
export const WAITING_INPUT_SETTINGS = Symbol('WaitingInputSettings');
