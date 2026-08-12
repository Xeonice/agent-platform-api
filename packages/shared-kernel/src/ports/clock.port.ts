/**
 * Clock port — the ONLY sanctioned source of "now".
 * The whole repo bans `new Date()` / `Date.now()` (eslint no-restricted-syntax,
 * docs/backend/01 §3, 25 §1.4). Time is the biggest source of test flakiness
 * (idle thresholds, 15min device codes, retry backoff, per-minute schedulers),
 * so it is funneled through this port to make those flows deterministic.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('Clock');
