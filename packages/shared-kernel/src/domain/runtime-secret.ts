/**
 * The single placeholder every runtime adapter substitutes for a real
 * `refresh_token` when it mints the SANITIZED provider auth file that gets
 * injected into a sandbox (docs/backend/05 §4.3 裁决 D-18 ③, 23 §8.2 I-CRD-9).
 *
 * WHY IT LIVES IN THE SHARED KERNEL: the same literal must be referenced by
 * three sides — the domain (invariant assertions), adapters/infrastructure
 * (construction at credential birth), and the contracts testkit (RA-16's exact
 * -equality assertion). 23 §4.5 forbids `domain → contracts`, so the shared
 * kernel is the only place all three can reach. Writing the literal separately
 * in each place would let the string the testkit asserts and the string the
 * adapter writes drift apart SILENTLY — which is precisely the class of bug
 * RA-16 exists to catch.
 *
 * WHY THE FIELD IS KEPT AT ALL (rather than deleted): codex refuses to start
 * with `missing field 'refresh_token'` (05 §1★★ 实测). The field must exist and
 * be a non-empty string; it must simply never be the real one. Refreshing is a
 * PLATFORM-side job (05 §5.1), so the sandbox never needs a usable value —
 * that is exactly what makes a placeholder viable.
 */
export const RUNTIME_REFRESH_TOKEN_PLACEHOLDER = 'platform-managed-refresh-token-withheld';
