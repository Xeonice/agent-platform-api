import type { RuntimeAuthMethod } from '../value-objects/auth-challenge.vo';

/**
 * AuthMethodPolicy (docs/backend/23 §7.4). The available methods come from the
 * adapter's `getAuthMethods()`; RETURN ORDER = recommended priority (domain does not
 * re-sort, 04 §3). `assertSupported` guards `beginAuth` (testkit RA-03: an
 * out-of-list method → UNSUPPORTED_METHOD).
 */
export const AuthMethodPolicy = {
  assertSupported(method: RuntimeAuthMethod, available: RuntimeAuthMethod[]): void {
    if (!available.includes(method)) {
      throw new UnsupportedAuthMethodError(method);
    }
  },
};

/**
 * ⛔ **不要把码拼回 `message`。** 这里以前是 `unsupported auth method 'x' (UNSUPPORTED_METHOD)`，
 * 而 `RuntimeApplicationService` 直接拿它当 HTTP message —— 信封 `code` 却是
 * `codeForStatus(400)` 算出来的 `BAD_REQUEST`，同一个响应两个码。
 * 码由抛 HTTP 那一层放进 `code` 位（见 `unsupportedMethod()`），这里只留一句给日志读的话。
 */
export class UnsupportedAuthMethodError extends Error {
  constructor(readonly method: string) {
    super(`unsupported auth method '${method}'`);
    this.name = 'UnsupportedAuthMethodError';
  }
}
