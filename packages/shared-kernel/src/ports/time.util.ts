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

/**
 * 外部交来的时刻字符串 → 归一化的 ISO-8601；读不出来就答 `undefined`。
 *
 * 与 `epochSecondsToIso` 同一条纪律、同一个豁免理由：**它不读时钟**，只转换一个第三方
 * 已经定下的绝对时刻。这里的第三方是**构建脚本**——`GET /api/system/version` 的 `builtAt`
 * 由 `Dockerfile` 的 `APP_BUILT_AT` 在构建期注入（10 §6.6）。
 *
 * ⚠️ **为什么不能原样透传那个字符串**：`SystemVersionDtoSchema` 把 `builtAt` 声明成
 * `z.string().datetime()`，而值来自构建脚本手里的一句 shell —— `date` 少了 `-u`、用了
 * `+%F %T`、或者 CI 里那个变量压根没展开（原样留下 `$(date ...)`），送进来的都是**非空
 * 但形状不对**的字符串。透传的结果是平台自己吐出一份违反自己契约的响应。
 *
 * ⚠️ **返回值用 `toISOString()` 回写而不是原串**：`Date.parse` 接受一些 `datetime()` 不
 * 接受的写法（例如 `2026-09-16 08:30:00Z` 那个空格），放过去照样违约。归一化之后
 * **进去能被解析的，出来一定合规**。
 *
 * ⛔ 读不出来时**不要**退回 `clock.now()` —— 那会把「不知道什么时候构建的」伪装成
 * 「刚刚构建的」，而这个字段的用途正是报障时对账。
 */
export function toIsoInstant(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? fromEpochMs(ms).toISOString() : undefined;
}
