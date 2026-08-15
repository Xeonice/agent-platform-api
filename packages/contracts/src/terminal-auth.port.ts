/**
 * Terminal WS authentication port (docs/backend/06 §2, SANDBOX-RUNTIME-DECISIONS
 * 安全姿态). The `/terminal` socket.io gateway lives in the `terminal` module and
 * must NOT reach into `apps/api`'s access-passcode internals — so the handshake
 * auth check is expressed as this framework-agnostic port. The composition root
 * (apps/api) binds it to an adapter over `PasscodeService`.
 *
 * Rationale: the REST/MCP `PasscodeGuard` self-exempts non-HTTP contexts, which
 * left the WS handshake unauthenticated (S1 audit P1-1). This port closes that
 * hole for the terminal namespace WITHOUT the gateway importing app internals.
 */
export interface TerminalHandshakeCredentials {
  /** raw passcode presented on the socket.io handshake (auth / query / header). */
  passcode?: string;
  /** the `ap_session` signed session cookie value, if the browser already has one. */
  sessionToken?: string;
}

export interface TerminalAuthenticator {
  /**
   * Decide whether a terminal socket handshake may proceed. Implementations that
   * are disabled (no passcode configured) MUST return `true` (dev/local parity
   * with the REST guard). The implementation owns its own clock — callers never
   * pass wall-clock time.
   */
  authorize(credentials: TerminalHandshakeCredentials): boolean;
}

export const TERMINAL_AUTHENTICATOR = Symbol('TerminalAuthenticator');
