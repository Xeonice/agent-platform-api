import { describe, it, expect } from 'vitest';
import { runHalfStub } from '../_run-half';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Clock } from '@platform/shared-kernel';
import { AdapterAuthError, UnknownRuntimeError } from '@platform/contracts';
import type {
  AuthChallenge,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeCredential,
} from '@platform/contracts';
import { RuntimeApplicationService } from '../../src/application/runtime-application.service';
import type { AuthHelper, AuthHelperSession } from '../../src/domain/ports/auth-helper.port';

/**
 * `mapAdapterError` (04 §4 ★4z) — a THIRD-PARTY adapter's error must reach the user as
 * the same HTTP status a built-in's does.
 *
 * ⛔ THE TRAP THIS SUITE CLOSES, in the order a third party walks into it:
 *   1. testkit RA-03 says 「`contracts` defines no adapter error CLASS, so a plain Error
 *      is tolerated; but an error that DOES carry a code must carry the right one」;
 *   2. they throw a plain `Error` with `code = 'AUTH_REJECTED'`, and RA-03 goes GREEN —
 *      it reads `code` structurally;
 *   3. at runtime the mapping used `e instanceof AdapterAuthError`, a class exported
 *      from neither `@platform/contracts` nor `@platform/runtime` ⇒ the error fell
 *      through as a **500**, where a built-in throwing the same thing yields 401.
 *
 * Testkit and runtime judged ONE question by TWO criteria. Both halves are covered
 * below: the plain-Error case (structural dispatch) and the class case (now importable).
 */

const clock: Clock = { now: () => new Date(1_700_000_000_000) };

function registryWith(adapters: RuntimeAdapter[]): RuntimeAdapterRegistry {
  const map = new Map(adapters.map((a) => [a.id, a]));
  return {
    register: (a) => void map.set(a.id, a),
    get: (id) => {
      const a = map.get(id);
      if (!a) throw new Error(`unknown runtime '${id}'`);
      return a;
    },
    has: (id) => map.has(id),
    list: () => [...map.values()],
  };
}

/** A helper session that never produces anything — `beginAuth` throws before reading. */
const inertHelper: AuthHelper = {
  openSession: async (): Promise<AuthHelperSession> => ({
    homeDir: '/tmp/inert',
    pty: {
      ref: 'inert',
      detach: () => undefined,
      onData: () => undefined,
      write: () => undefined,
      resize: () => undefined,
      onExit: () => undefined,
      kill: async () => undefined,
    },
    dispose: async () => undefined,
  }),
};

/** An adapter whose `beginAuth` throws whatever the test hands it. */
function throwingAdapter(id: string, thrown: unknown): RuntimeAdapter {
  return {
    ...runHalfStub,
    id,
    displayName: id,
    vendor: 'test',
    loginCommand: () => [id, 'login'],
    getAuthMethods: () => ['oauth-device'],
    beginAuth: (): Promise<AuthChallenge> => Promise.reject(thrown),
    completeAuth: (): Promise<RuntimeCredential> => Promise.reject(thrown),
    injectCredential: async () => undefined,
  };
}

function serviceFor(adapter: RuntimeAdapter): RuntimeApplicationService {
  return new RuntimeApplicationService(
    registryWith([adapter]),
    inertHelper,
    undefined as never, // settings
    { put: () => undefined, settle: () => undefined, sweepOutcomes: () => undefined } as never,
    undefined as never, // credentials
    undefined as never, // uow
    undefined as never, // events
    clock,
    { next: () => 'chal-1' } as never,
  );
}

/** A plain Error carrying a code — exactly what testkit RA-03 teaches. */
function bareErrorWithCode(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('mapAdapterError judges the adapter error STRUCTURALLY (04 §4 ★4z)', () => {
  const cases = [
    ['AUTH_REJECTED', UnauthorizedException],
    ['UNSUPPORTED_METHOD', BadRequestException],
    ['AUTH_CHALLENGE_EXPIRED', NotFoundException],
    ['INSTALL_FAILED', InternalServerErrorException],
  ] as const;

  for (const [code, expected] of cases) {
    it(`a third party's PLAIN Error with code '${code}' maps like a built-in's`, async () => {
      const svc = serviceFor(throwingAdapter('acme', bareErrorWithCode(code, `boom ${code}`)));
      await expect(svc.beginAuth('acme', 'oauth-device')).rejects.toBeInstanceOf(expected);
    });

    it(`an AdapterAuthError('${code}') — now importable from contracts — maps the same`, async () => {
      const svc = serviceFor(throwingAdapter('acme', new AdapterAuthError(code, `boom ${code}`)));
      await expect(svc.beginAuth('acme', 'oauth-device')).rejects.toBeInstanceOf(expected);
    });
  }

  it('the ORIGINAL message survives the mapping (an empty 401 explains nothing)', async () => {
    const svc = serviceFor(
      throwingAdapter('acme', bareErrorWithCode('AUTH_REJECTED', 'acme rejected the key')),
    );
    await expect(svc.beginAuth('acme', 'oauth-device')).rejects.toThrow(/acme rejected the key/);
  });

  it('a thrown plain OBJECT with {code,message} is honoured too (testkit admits it)', async () => {
    const svc = serviceFor(
      throwingAdapter('acme', { code: 'AUTH_REJECTED', message: 'object-shaped' }),
    );
    await expect(svc.beginAuth('acme', 'oauth-device')).rejects.toThrow(/object-shaped/);
  });

  it("⛔ an UNRELATED `.code` is NOT coerced into an auth verdict (Node's ENOENT)", async () => {
    // Structural dispatch must recognise only the 04 §4 closed set. A `.code` of
    // `ENOENT` is a string on an Error too — mapping it to 401 would tell the user
    // 「未授权」 about a missing file.
    const svc = serviceFor(throwingAdapter('acme', bareErrorWithCode('ENOENT', 'no such file')));
    const err = await svc.beginAuth('acme', 'oauth-device').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnauthorizedException);
    expect(err).not.toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toBe('no such file');
  });

  it('UNKNOWN_RUNTIME keeps its own code and is not re-labelled', async () => {
    const svc = serviceFor(throwingAdapter('acme', new UnknownRuntimeError('ghost')));
    const err = await svc.beginAuth('acme', 'oauth-device').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownRuntimeError);
  });
});
