import { HttpException, HttpStatus } from '@nestjs/common';
import { MANIFEST_INVALID, ImageSpecError, REF_NOT_FOUND } from '@platform/contracts';
import { VALIDATION_FAILED_CODE } from '@platform/contracts';
import {
  ImageDeleteRefusedError,
  ImageNotFoundError,
  ManifestInvalidError,
  PatchCannotActivateError,
} from './image-application.service';
import { EnvValidationError, ImageStateError } from '../domain/errors/image-errors';

/**
 * The ONE table that turns an image-context failure into an `ErrorEnvelope`
 * (04 §4「一张表」, 10 §6.8).
 *
 * It lives in `application`, not `interface`, for the same reason the sandbox
 * context's `provider-error.http.ts` and `door-rejection.http.ts` do: the table has to
 * see DOMAIN errors (`EnvValidationError`, `ImageStateError`), and
 * `eslint-plugin-boundaries` forbids `interface → domain`. The layer that legitimately
 * knows both the domain and the wire is the application layer.
 *
 * ⚠️ EVERY BRANCH EMITS A FULL ENVELOPE, NOT A BARE NEST EXCEPTION. A
 * `new NotFoundException('…')` serialises as `{statusCode, message, error}`, which the
 * frontend's `toApiError` does not recognise and replaces wholesale with 「请求失败
 * (HTTP 404)」 — losing the sentence that told the user what to do. The global
 * `ErrorEnvelopeFilter` would normalise it, but only to a generic `NOT_FOUND`; the
 * specific codes below (`MANIFEST_INVALID`, `REGISTRY_UNREACHABLE`, …) exist precisely
 * so the frontend can say something different for each.
 *
 * ⚠️ `sideEffectFree` IS STATED HERE BECAUSE THESE PATHS KNOW IT. Registration
 * refuses an `invalid` manifest BEFORE any write (24 §7.2「invalid 不落库」), so
 * nothing was created and there is nothing to retry — the user edits the image and
 * submits again. `REGISTRY_UNREACHABLE` is the one retryable member of the group, and
 * it is also side-effect free: the transaction had not started.
 */
export function toImageHttpError(e: unknown): unknown {
  if (e instanceof ManifestInvalidError) {
    return new HttpException(
      {
        code: MANIFEST_INVALID,
        message: e.message,
        retryable: false,
        sideEffectFree: true,
        // `IMAGE_TMUX_MISSING` and friends live HERE — as `details[].code` — never as
        // the top-level code (10 §6.8 本轮补的两条定案 ②).
        details: e.outcome.errors.map((f) => ({ path: f.path, code: f.code, message: f.message })),
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  if (e instanceof ImageSpecError) {
    const notFound = e.code === REF_NOT_FOUND;
    return new HttpException(
      {
        code: e.code,
        message: e.message,
        retryable: e.retryable,
        sideEffectFree: true,
      },
      notFound ? HttpStatus.NOT_FOUND : HttpStatus.BAD_GATEWAY,
    );
  }
  if (e instanceof EnvValidationError) {
    return new HttpException(
      {
        // Top-level code is `VALIDATION_FAILED`, exactly as for a zod failure: the two
        // reject different things (DTO shape vs domain rule) but the user does the
        // same thing about both, and the frontend copy table is keyed on this code.
        code: VALIDATION_FAILED_CODE,
        message: '运行参数不合法，请按提示逐项修正',
        retryable: false,
        sideEffectFree: true,
        details: e.issues.map((i) => ({ path: i.path, code: i.code, message: i.message })),
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  if (e instanceof PatchCannotActivateError) {
    return new HttpException(
      { code: 'BAD_REQUEST', message: e.message, retryable: false, sideEffectFree: true },
      HttpStatus.BAD_REQUEST,
    );
  }
  if (e instanceof ImageStateError) {
    return new HttpException(
      { code: 'INVALID_STATE', message: e.message, retryable: false, sideEffectFree: true },
      HttpStatus.CONFLICT,
    );
  }
  if (e instanceof ImageDeleteRefusedError) {
    return new HttpException(
      { code: 'INVALID_STATE', message: e.message, retryable: false, sideEffectFree: true },
      HttpStatus.CONFLICT,
    );
  }
  if (e instanceof ImageNotFoundError) {
    return new HttpException(
      { code: 'NOT_FOUND', message: e.message, retryable: false, sideEffectFree: true },
      HttpStatus.NOT_FOUND,
    );
  }
  return e;
}

/** Run a controller body and map anything that escapes through the table above. */
export async function mapImageErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toImageHttpError(e);
  }
}
