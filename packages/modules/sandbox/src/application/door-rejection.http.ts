import { HttpException, type HttpStatus } from '@nestjs/common';
import { mapProviderErrorToHttp } from './provider-error.http';

/**
 * 「门口拒绝」 — the create door of 04 §5 「创建前静态校验」, as a wire concern.
 *
 * A door rejection is a refusal issued 不进调度、不落库、不调 `provider.create`. That
 * makes it a categorically different answer from "we tried and it broke": there is no
 * id to show, no row in any list, nothing to clean up, and nothing for a [重试] button
 * to act on. `ErrorEnvelope.sideEffectFree` is how that fact reaches the frontend
 * (shared/10 §6.8), and this module is the only place that writes it.
 */

/** `create` named a provider that is not in the registry (04 §8 open registry). */
export const UNKNOWN_PROVIDER_CODE = 'UNKNOWN_PROVIDER';
/** `create` named an image reference the platform refuses to hand to a container runtime. */
export const INVALID_IMAGE_REFERENCE_CODE = 'INVALID_IMAGE_REFERENCE';

/**
 * Build a door rejection as a REAL envelope (`code` + `message` + `retryable`).
 *
 * ⚠️ IT EXISTS BECAUSE THREE OF THE FOUR DOOR REJECTIONS WERE NOT ENVELOPES AT ALL.
 * `unknown provider` / `invalid image reference` / `unknown runtime` were thrown as
 * `new BadRequestException('…')`, which Nest serialises as
 * `{statusCode, message, error}` — no `code`, no `retryable`. The frontend's
 * `toApiError` treats a body without those two as "not an envelope" and replaces the
 * whole thing with `{code:'UNKNOWN', message:'请求失败（HTTP 400）', retryable:false}`,
 * so the backend's exact sentence ("unknown runtime 'shell'") never reached the user
 * who could have acted on it. Adding a field to a body nobody reads fixes nothing;
 * the body has to be an envelope first.
 *
 * ⚠️ A DOOR REJECTION IS ALWAYS `retryable: false`, AND THAT IS A PROPERTY OF DOORS,
 * NOT A PER-CASE JUDGEMENT. The door's answer is "this request, as written, is not
 * accepted". Sending the identical bytes again is refused identically — what has to
 * change is the request or a precondition outside it. This is the same reasoning
 * `UnknownRuntimeError.retryable = false` already carries (04 §4): a [重试] whose every
 * press is guaranteed to fail is worse than no button.
 *
 * ⚠️ IT DOES NOT SET `sideEffectFree`. That is deliberate — see `atDoor`.
 */
export function doorRejection(status: HttpStatus, code: string, message: string): HttpException {
  return new HttpException({ code, message, retryable: false }, status);
}

/**
 * Run a 「门口」 region; stamp `sideEffectFree: true` on anything that escapes it.
 *
 * ⚠️ THE FLAG IS WRITTEN HERE AND NOWHERE ELSE ON THE CREATE PATH, AND IT IS EARNED BY
 * POSITION RATHER THAN DECLARED PER ERROR. (One other place in the repo writes it: the
 * zod validation pipe, which runs BEFORE any controller — `apps/api/src/bootstrap/
 * validation.pipe.ts`, 04 §4.2. Same reasoning, different position; a DTO violation
 * never reaches this service at all.) The caller wraps a region that provably performs no writes,
 * no scheduling and no `provider.create`; every rejection leaving that region is
 * side-effect free BECAUSE OF WHERE IT WAS THROWN, not because its author remembered a
 * field. So a door check added next year — by someone who has never read this file —
 * is stamped correctly the moment it is placed inside the region, and a `doorRejection`
 * accidentally thrown from OUTSIDE a door cannot claim a guarantee it does not have.
 *
 * Marking each throw site by hand is the alternative, and it is exactly how three of
 * the four existing door rejections came to be unmarked in the first place.
 *
 * Contract errors are mapped on the way out (04 §4's one table), so a door check may
 * throw either an `HttpException` or a contract error and both arrive as one envelope.
 * Anything that is NOT an `HttpException` after mapping — a genuine bug inside the
 * door — is passed through untouched: it becomes a bare 500 with no envelope, i.e. it
 * falls back to the conservative "not stated" reading rather than claiming anything.
 */
export async function atDoor<T>(region: () => Promise<T>): Promise<T> {
  try {
    return await region();
  } catch (e) {
    throw markSideEffectFree(mapProviderErrorToHttp(e));
  }
}

function markSideEffectFree(e: unknown): unknown {
  if (!(e instanceof HttpException)) return e;
  const body: unknown = e.getResponse();
  if (typeof body !== 'object' || body === null) return e;
  return new HttpException({ ...body, sideEffectFree: true }, e.getStatus(), { cause: e });
}
