import { describe, it, expect } from 'vitest';
import { ConflictException, HttpException } from '@nestjs/common';
import {
  ProjectAccessError,
  SandboxProviderError,
  SandboxProviderErrorCode,
} from '@platform/contracts';
import { mapProviderErrorToHttp } from '../../src/application/provider-error.http';
import { FULL_CAPS as FULL, FakeProvider, harness, type HarnessOptions } from './_harness';

/**
 * THE CREATE DOOR AND ITS 零副作用 CONTRACT (04 §5 「创建前静态校验」, shared/10 §6.8).
 *
 * ── What this file is defending ───────────────────────────────────────────────────
 * Two failures look identical to a caller and are not the same event:
 *   ① 「被拒」 — refused 不进调度、不落库、不调 `provider.create`. No id exists, no row is
 *      listed, nothing needs cleaning up. The user must CHANGE the request.
 *   ② 「失败」 — accepted, then broke partway. Something half-made may exist, and
 *      [重试] is a sensible offer.
 * The frontend used to separate them by `httpStatus === 409`, which covered exactly ONE
 * of the four rejections this door produces. `ErrorEnvelope.sideEffectFree` replaces
 * that proxy with the platform stating the fact directly.
 *
 * ── Why every case also asserts `code` ────────────────────────────────────────────
 * Three of these bodies used to be `new BadRequestException('…')`, i.e. Nest's
 * `{statusCode, message, error}`. The frontend's `toApiError` requires `code` AND
 * `retryable` before it will treat a body as an envelope, and replaces everything else
 * with `{code:'UNKNOWN', message:'请求失败（HTTP 400）'}` — so a `sideEffectFree` added
 * to such a body would have been read by nobody. Asserting `code` here is what keeps
 * the field reachable, not decoration.
 */

const base = { projectId: 'prj-1', runtime: 'claude-code' };

/** Every door rejection `create()` can produce today, each with the envelope it owes. */
const DOOR_REJECTIONS: {
  what: string;
  status: number;
  code: string;
  opts?: HarnessOptions;
  input: Record<string, unknown>;
}[] = [
  {
    what: 'a provider that is not in the registry',
    status: 400,
    code: 'UNKNOWN_PROVIDER',
    input: { ...base, provider: 'nope' },
  },
  {
    what: 'a runtime that is not in the registry (04 §8 sibling registry)',
    status: 400,
    code: 'UNKNOWN_RUNTIME',
    input: { ...base, runtime: 'shell' },
  },
  {
    what: 'an image reference carrying a control character',
    status: 400,
    code: 'INVALID_IMAGE_REFERENCE',
    // built from an escape, never pasted raw — a literal 0x1b makes git treat the file
    // as binary (no diff, no review).
    input: { ...base, image: `alpine:3.20${String.fromCharCode(0x1b)}[2J` },
  },
  {
    what: 'a capability the chosen provider does not advertise',
    status: 409,
    code: 'UNSUPPORTED_CAPABILITY',
    opts: { providers: [new FakeProvider('aio', { ...FULL, snapshot: false })] },
    input: { ...base, require: { snapshot: true } },
  },
  {
    what: 'a project that does not exist',
    status: 404,
    code: 'PROJECT_NOT_FOUND',
    opts: { projectError: new ProjectAccessError('PROJECT_NOT_FOUND', 'project prj-1 not found') },
    input: base,
  },
  {
    what: 'a project that cannot accept a task yet (I-PRJ)',
    status: 409,
    code: 'PROJECT_NOT_READY',
    opts: {
      projectError: new ProjectAccessError('PROJECT_NOT_READY', 'project prj-1 is not ready'),
    },
    input: base,
  },
];

async function reject(opts: HarnessOptions, input: Record<string, unknown>) {
  const h = harness(opts);
  const e = await h.service
    .create(input as never)
    .then(() => null)
    .catch((err: unknown) => err);
  expect(e, 'create() was expected to reject').toBeInstanceOf(HttpException);
  return { h, http: e as HttpException };
}

describe('the create door answers every rejection with a 零副作用 envelope', () => {
  for (const c of DOOR_REJECTIONS) {
    it(`${c.what} → ${String(c.status)} ${c.code}`, async () => {
      const { h, http } = await reject(c.opts ?? {}, c.input);

      expect(http.getStatus()).toBe(c.status);
      expect(http.getResponse()).toMatchObject({
        code: c.code,
        // 门口拒绝一律不可重试: re-sending the identical request is refused identically.
        retryable: false,
        // the field this whole file exists for.
        sideEffectFree: true,
      });

      // …and the flag is TRUE, not merely present: 04 §5「不进调度、不落库、不调
      // provider.create」asserted as three separate observations so a regression says
      // WHICH half of the promise broke.
      expect(h.provider.calls).toEqual([]);
      expect(h.wsCalls).toEqual([]);
      expect(h.repo.store.size).toBe(0);
    });
  }

  it('a request that passes the door is not answered with an envelope at all', async () => {
    const h = harness();
    await expect(h.service.create(base)).resolves.toMatchObject({ status: 'pending' });
  });
});

/**
 * ── THE GUARD ─────────────────────────────────────────────────────────────────────
 *
 * The table above pins the six rejections that exist TODAY. It cannot pin the seventh,
 * because a list of known cases is exactly the thing a new case is missing from — and
 * "three of the four were never marked" is what that failure mode looks like in
 * practice.
 *
 * So the guard does not test a list; it tests the MECHANISM. `sideEffectFree` is written
 * in one place (`atDoor`) and earned by POSITION: whatever leaves the door region gets
 * it, because of where it was thrown rather than because its author knew the field
 * exists. The two tests below drive a rejection through the door that this codebase has
 * never seen — one raised as a plain Nest exception, one as a contract error — and
 * require both to come out marked.
 *
 * That is the property a future door check inherits for free. Its cost is a real
 * constraint: a new door check MUST live inside `SandboxApplicationService.admit`. One
 * added after `persist()` would not be marked — and would be right not to be.
 */
describe('the guard: 零副作用 is earned by position, not by remembering a field', () => {
  it('marks a door rejection whose throw site has never heard of `sideEffectFree`', async () => {
    // A stand-in for next year's door check: it sets `code`/`message`/`retryable` — the
    // envelope fields that predate this work — and says nothing about side effects.
    const { http } = await reject(
      {
        projectError: new ConflictException({
          code: 'SOME_FUTURE_DOOR_RULE',
          message: 'a rule nobody has written yet',
          retryable: false,
        }),
      },
      base,
    );

    expect(http.getStatus()).toBe(409);
    expect(http.getResponse()).toMatchObject({
      code: 'SOME_FUTURE_DOOR_RULE',
      sideEffectFree: true,
    });
  });

  it('…including one raised as a contract error rather than an HttpException', async () => {
    // The other throwing style the door supports: 04 §4's table maps it on the way out,
    // and the marking happens after that — so both styles arrive as one envelope shape.
    const { http } = await reject(
      {
        projectError: new SandboxProviderError(
          SandboxProviderErrorCode.RESOURCE_EXHAUSTED,
          'no capacity for a new sandbox',
          undefined,
          true,
        ),
      },
      base,
    );

    expect(http.getStatus()).toBe(429);
    expect(http.getResponse()).toMatchObject({
      code: 'RESOURCE_EXHAUSTED',
      // the door does NOT overwrite the error's own verdict — it only adds the fact the
      // error could not know: that nothing happened yet.
      retryable: true,
      sideEffectFree: true,
    });
  });

  it('does NOT mark a failure raised outside the door — absence stays the default', async () => {
    // The counter-case, and the reason the field is optional. A provider error mapped on
    // any other path (teardown, the provision workflow, the task plane) has no such
    // guarantee behind it, so it must arrive WITHOUT the field — which every consumer
    // reads as "there may have been side effects", i.e. the pre-existing behaviour.
    const mapped = mapProviderErrorToHttp(
      new SandboxProviderError(SandboxProviderErrorCode.INVALID_STATE, 'already destroyed'),
    );
    expect(mapped).toBeInstanceOf(HttpException);
    expect((mapped as HttpException).getResponse()).not.toHaveProperty('sideEffectFree');
  });
});
