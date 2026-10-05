/** Transient terminal display projection; never a lifecycle or scheduling signal. */
export interface WaitingInputQueryPort {
  isWaiting(sandboxId: string): boolean;
  filterWaiting(sandboxIds: string[]): Set<string>;
}

export const WAITING_INPUT_QUERY = Symbol('WaitingInputQueryPort');
