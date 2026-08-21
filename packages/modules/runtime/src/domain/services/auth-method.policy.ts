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

export class UnsupportedAuthMethodError extends Error {
  constructor(readonly method: string) {
    super(`unsupported auth method '${method}' (UNSUPPORTED_METHOD)`);
    this.name = 'UnsupportedAuthMethodError';
  }
}
