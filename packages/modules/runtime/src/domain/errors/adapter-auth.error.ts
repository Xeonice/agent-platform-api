/**
 * RuntimeAdapter error taxonomy (docs/backend/04 §4). The interface layer maps these
 * codes to HTTP (05 §3 / 27 §4).
 */
export type AdapterAuthErrorCode =
  | 'INSTALL_FAILED'
  | 'AUTH_CHALLENGE_EXPIRED'
  | 'AUTH_REJECTED'
  | 'BINARY_NOT_FOUND'
  | 'UNSUPPORTED_METHOD'
  | 'PARSE_ERROR';

export class AdapterAuthError extends Error {
  constructor(
    readonly code: AdapterAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterAuthError';
  }
}
