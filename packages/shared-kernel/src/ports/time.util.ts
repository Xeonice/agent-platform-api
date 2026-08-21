/**
 * Clock-safe date arithmetic. The repo bans `new Date()` everywhere outside the
 * Clock port impl (eslint no-restricted-syntax), which also blocks `new Date(ms)`.
 * This helper derives a shifted instant by MUTATING a throwaway `Date` (typically a
 * fresh `clock.now()`), so callers never touch the `Date` constructor.
 */
export function shiftMs(base: Date, ms: number): Date {
  base.setTime(base.getTime() + ms);
  return base;
}
