/**
 * IdGenerator port — the ONLY sanctioned source of ids.
 * The repo bans `crypto.randomUUID()` directly (see 01 §3); domain/application
 * take ids through this port so tests can inject deterministic sequences.
 */
export interface IdGenerator {
  next(): string;
}

export const ID_GENERATOR = Symbol('IdGenerator');
