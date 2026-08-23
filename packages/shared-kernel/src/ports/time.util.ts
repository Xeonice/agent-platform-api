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

/**
 * Absolute epoch → `Date`, for timestamps that come from OUTSIDE the platform.
 *
 * WHY THIS NEEDS AN ESLINT EXEMPTION AND WHY THAT IS NOT A LOOPHOLE: the repo-wide
 * ban on the `Date` constructor exists so that "now" always comes from the Clock port
 * (01 §3) — otherwise tests cannot pin time. This function reads NO clock: it is a
 * pure function of its argument, converting a timestamp a third party already
 * decided (the in-sandbox agent reports file mtimes as epoch SECONDS in a STRING —
 * 04 §2.6). Routing that through `Clock` would be nonsense; hand-rolling ISO-8601
 * from integer arithmetic would be worse. So the constructor is used HERE, in one
 * named place, and `eslint.config.mjs` exempts exactly this file.
 */
export function fromEpochMs(ms: number): Date {
  return new Date(ms);
}

/**
 * The agent's `modified_time` encoding → ISO-8601 (04 §2.6 「provider 归一」).
 * Accepts the string-wrapped epoch SECONDS it really sends, plus a plain number,
 * and answers `undefined` for anything it cannot read rather than inventing a time.
 */
export function epochSecondsToIso(value: unknown): string | undefined {
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds)) return undefined;
  return fromEpochMs(Math.round(seconds * 1000)).toISOString();
}
