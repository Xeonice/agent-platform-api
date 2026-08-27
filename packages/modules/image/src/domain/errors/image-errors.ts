/**
 * Image-context domain errors (docs/backend/23 §9, shared/10 §6.8).
 *
 * ⚠️ THE FOUR `ENV_*` CODES LIVE IN `details[].code`, NOT AS A TOP-LEVEL `code`.
 * The top-level code is `VALIDATION_FAILED` (400 / retryable:false /
 * sideEffectFree:true) — the same one the zod pipe already emits, deliberately reused
 * rather than inventing `ENV_VALIDATION_FAILED`: the frontend's copy table is keyed on
 * the TOP-LEVEL code, the presentation is identical (就地标红，不出失败卡), and a
 * second code would only be one more branch to remember. The two paths differ in what
 * they reject — zod rejects a DTO SHAPE, `EnvVarSet` rejects a DOMAIN RULE — but they
 * land in the same envelope (10 §6.8 本轮补的两条定案 ①).
 */

/** Name does not match `^[A-Za-z_][A-Za-z0-9_]*$`. */
export const ENV_NAME_INVALID = 'ENV_NAME_INVALID';
/** Name is on the reserved blacklist (exact or `CODEX_*` / `GIT_*` prefix). */
export const ENV_NAME_RESERVED = 'ENV_NAME_RESERVED';
/** >50 entries, name >64 chars, or value >4096 BYTES (UTF-8). */
export const ENV_LIMIT_EXCEEDED = 'ENV_LIMIT_EXCEEDED';
/** Two entries share a key (case-SENSITIVE, 13 §2.4.3). */
export const ENV_DUPLICATE_KEY = 'ENV_DUPLICATE_KEY';

export type EnvValidationCode =
  | typeof ENV_NAME_INVALID
  | typeof ENV_NAME_RESERVED
  | typeof ENV_LIMIT_EXCEEDED
  | typeof ENV_DUPLICATE_KEY;

export interface EnvValidationIssue {
  /** Dotted path AT the offending item — `env[3].key` (10 §6.8). */
  path: string;
  code: EnvValidationCode;
  message: string;
}

/**
 * Thrown by `EnvVarSet.create` (23 I-IMG-1, 构造即校验).
 *
 * ⚠️ IT CARRIES **EVERY** VIOLATION, NOT THE FIRST. A form with three bad variables
 * that reports one per round-trip is three round-trips; the逐项 `details[]` shape in
 * the envelope exists precisely so the whole form can be marked up at once.
 *
 * ⚠️ AND `message` NEVER CONTAINS THE SUBMITTED VALUE — only the path, the rule and
 * the expectation. Env values are the most likely place for a plaintext token, and
 * this message goes into a rendered envelope, a log line and a user's screenshot.
 */
export class EnvValidationError extends Error {
  constructor(readonly issues: EnvValidationIssue[]) {
    super(`env validation failed (${String(issues.length)} issue(s))`);
    this.name = 'EnvValidationError';
  }
}

/** The manifest exists but the requested transition is not allowed (409 `INVALID_STATE`). */
export class ImageStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageStateError';
  }
}

/** A built-in image may be disabled, never deleted (23 I-IMG-4). */
export class ImageNotDeletableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageNotDeletableError';
  }
}
