import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ImageContractViolationError,
  RuntimeInstallFailedError,
  SandboxProviderError,
  SandboxProviderErrorCode,
} from '@platform/contracts';

/**
 * The ONE contract-error → HTTP table (04 §4 interface mapping), shared by every
 * application service in this context.
 *
 * `INSTALL_FAILED` / `IMAGE_CONTRACT_VIOLATION` are included even though their MAIN
 * exposure is not HTTP: both happen inside a background workflow, long after the
 * caller got its 202, and reach the user as a failed state plus a WS frame. They are
 * mapped anyway for the two reasons 04 §4 states — a future synchronous entry point
 * needs a rule to follow, and 02 §6.2 forbids an error code with no mapping.
 */
export const PROVIDER_HTTP: Record<SandboxProviderErrorCode, number> = {
  [SandboxProviderErrorCode.IMAGE_PULL_FAILED]: HttpStatus.BAD_GATEWAY,
  [SandboxProviderErrorCode.PROVIDER_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
  [SandboxProviderErrorCode.RESOURCE_EXHAUSTED]: HttpStatus.TOO_MANY_REQUESTS,
  [SandboxProviderErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [SandboxProviderErrorCode.ALREADY_EXISTS]: HttpStatus.CONFLICT,
  [SandboxProviderErrorCode.INVALID_STATE]: HttpStatus.CONFLICT,
  [SandboxProviderErrorCode.PERMISSION_DENIED]: HttpStatus.FORBIDDEN,
  [SandboxProviderErrorCode.TIMEOUT]: HttpStatus.GATEWAY_TIMEOUT,
  [SandboxProviderErrorCode.UNSUPPORTED_CAPABILITY]: HttpStatus.CONFLICT,
  [SandboxProviderErrorCode.INTERNAL]: HttpStatus.INTERNAL_SERVER_ERROR,
};

/** Map a thrown contract error onto the envelope + status the wire expects. */
export function mapProviderErrorToHttp(e: unknown): unknown {
  if (e instanceof HttpException) return e;
  if (e instanceof RuntimeInstallFailedError || e instanceof ImageContractViolationError) {
    return new HttpException(
      { code: e.code, message: e.message, retryable: e.retryable },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
  if (!(e instanceof SandboxProviderError)) return e;
  const status = PROVIDER_HTTP[e.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
  return new HttpException({ code: e.code, message: e.message, retryable: e.retryable }, status);
}
