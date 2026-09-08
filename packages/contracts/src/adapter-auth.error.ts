/**
 * RuntimeAdapter error taxonomy (docs/backend/04 §4). The interface layer maps these
 * codes to HTTP (05 §3 / 27 §4).
 *
 * ── WHY IT LIVES IN `contracts` (moved here 2026-09-08, 04 §4 ★4z) ─────────────
 * It used to live in `runtime/src/domain/errors/`, exported from neither
 * `@platform/contracts` nor `@platform/runtime` — so an OUT-OF-TREE adapter had no way
 * to reach it. That closed a trap with three steps and no visible seam:
 *
 *   1. testkit RA-03 tells you 「`contracts` defines no adapter error CLASS, so a plain
 *      Error is tolerated; but an error that DOES carry a code must carry the right
 *      one」 ⇒ you throw a plain `Error` with a `code`.
 *   2. RA-03 goes GREEN — it reads `code` structurally (`errorCodeOf`).
 *   3. At runtime `mapAdapterError` used `e instanceof AdapterAuthError`, which your
 *      plain Error is not ⇒ it falls through and surfaces as **500**, where a built-in
 *      throwing the very same thing surfaces as 401.
 *
 * Two judgements follow, and BOTH are implemented rather than either alone:
 *   · `mapAdapterError` now dispatches STRUCTURALLY on `code`, exactly like the
 *     testkit — so the two stop using different criteria for one question, and a bare
 *     `Error` carrying a valid code is honoured;
 *   · the class and its code table live HERE, so a third party can also just `throw
 *     new AdapterAuthError(...)` and get the same behaviour as a built-in.
 *
 * ⚠️ THE DDD RULE IS UNCHANGED (04 §4 「分层映射原则」): a `domain` layer may not
 * import contracts. Nothing in domain used this class — only `application` (which maps
 * it to HTTP) and `infrastructure` (the adapters, which throw it) did, and both layers
 * are already allowed to depend on contracts. So the move is a pure widening.
 */

/**
 * The closed set, as a VALUE — the structural check needs to test membership at
 * runtime, and a bare type union cannot be iterated.
 */
export const ADAPTER_AUTH_ERROR_CODES = [
  'INSTALL_FAILED',
  'AUTH_CHALLENGE_EXPIRED',
  'AUTH_REJECTED',
  'BINARY_NOT_FOUND',
  'UNSUPPORTED_METHOD',
  'PARSE_ERROR',
] as const;

export type AdapterAuthErrorCode = (typeof ADAPTER_AUTH_ERROR_CODES)[number];

/**
 * `AUTH_REJECTED` as a named constant so `SANDBOX_FAILURE_CODES` can COMPOSE it rather
 * than re-typing the literal (that file's own rule: a re-typed literal drifts and the
 * failure it names silently degrades to `INTERNAL`).
 */
export const AUTH_REJECTED: AdapterAuthErrorCode = 'AUTH_REJECTED';

export function isAdapterAuthErrorCode(value: unknown): value is AdapterAuthErrorCode {
  return (
    typeof value === 'string' && (ADAPTER_AUTH_ERROR_CODES as readonly string[]).includes(value)
  );
}

export class AdapterAuthError extends Error {
  constructor(
    readonly code: AdapterAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterAuthError';
  }
}

/**
 * Read an adapter error's `code` STRUCTURALLY — the same criterion testkit RA-03 uses.
 *
 * ⚠️ It deliberately does NOT test `instanceof`: a third-party adapter throwing a plain
 * `Error` with a valid `code` is behaviour the testkit explicitly sanctions, and an
 * `instanceof` check would also fail across duplicated package copies (two
 * `@platform/contracts` in one `node_modules` tree is a realistic npm outcome).
 * Returns `undefined` for anything that carries no usable code — including a Node fs
 * error, whose `code` (`ENOENT`, `EACCES`, …) is a string but not one of ours.
 */
export function adapterAuthErrorCodeOf(e: unknown): AdapterAuthErrorCode | undefined {
  if (typeof e !== 'object' || e === null || !('code' in e)) return undefined;
  const code: unknown = (e as { code: unknown }).code;
  return isAdapterAuthErrorCode(code) ? code : undefined;
}
