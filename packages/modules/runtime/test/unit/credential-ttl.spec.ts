import { describe, it, expect } from 'vitest';
import type { Clock } from '@platform/shared-kernel';
import type {
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeAuthMethod,
  RuntimeCredential,
} from '@platform/contracts';
import { RuntimeApplicationService } from '../../src/application/runtime-application.service';
import { AuthSessionStore } from '../../src/application/auth-session.store';
import { AuthChallenge } from '../../src/domain/value-objects/auth-challenge.vo';
import type {
  AuthHelperSession,
  HelperProcessStream,
} from '../../src/domain/ports/auth-helper.port';
import { CodexAdapter } from '../../src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../src/infrastructure/adapters/claude-code/claude-code.adapter';

/**
 * Credential EXPIRY is a vendor fact the ADAPTER declares (04 §3 `credentialTtlMs`),
 * not a platform table keyed by auth method.
 *
 * Before this slice the application layer held `oauth-device ⇒ 60min` (Codex's access
 * token) and `setup-token ⇒ 365d` (Claude's), so ANY third-party runtime that logs in
 * with `oauth-device` silently inherited the Codex hour and its credential was marked
 * expired 59 minutes early. These tests pin the fix in both directions: the two
 * built-ins keep their exact lifetimes, and a third-party adapter gets its own (or
 * none, if it declares none).
 */
// `shiftMs` MUTATES the Date it is handed (by design — see shared-kernel/time.util),
// so the test Clock must mint a FRESH instant per call exactly like the real one.
const NOW_MS = Date.parse('2026-08-21T00:00:00.000Z');
const NOW = () => new Date(NOW_MS);
const clock: Clock = { now: () => new Date(NOW_MS) };
const at = (offsetMs: number) => new Date(NOW_MS + offsetMs).toISOString();
const HOUR = 60 * 60_000;
const YEAR = 365 * 24 * HOUR;

function registryWith(adapters: RuntimeAdapter[]): RuntimeAdapterRegistry {
  const map = new Map(adapters.map((a) => [a.id, a]));
  return {
    register(a) {
      map.set(a.id, a);
    },
    get(id) {
      const a = map.get(id);
      if (!a) throw new Error(`unknown runtime '${id}'`);
      return a;
    },
    has: (id) => map.has(id),
    list: () => [...map.values()],
  };
}

/** Captures exactly the one field under test: the platform-stamped `expiresAt`. */
function capturingCredentials() {
  const stored: Array<{ runtimeId: string; expiresAt: Date | null }> = [];
  const service = {
    storeRuntimeCredential: async (input: {
      runtimeId: string;
      maskedIdentifier: string;
      expiresAt: Date | null;
    }) => {
      stored.push({ runtimeId: input.runtimeId, expiresAt: input.expiresAt });
      return { maskedIdentifier: input.maskedIdentifier };
    },
  };
  return { service, stored };
}

function credential(runtimeId: string, obtainedVia: RuntimeAuthMethod): RuntimeCredential {
  return {
    runtimeId,
    obtainedVia,
    maskedIdentifier: `${runtimeId}-…abcd`,
    issuedAt: NOW().toISOString(),
    credentialFiles: [],
    env: { TOKEN: 'plaintext' },
    zeroize(): void {
      this.env = undefined;
    },
  };
}

/**
 * A stub adapter that carries a REAL `credentialTtlMs` table (optionally borrowed from
 * a built-in) without driving a real CLI pty — the login mechanics are covered by the
 * adapter specs; here only the expiry stamping is under test.
 */
function stubAdapter(
  id: string,
  obtainedVia: RuntimeAuthMethod,
  credentialTtlMs?: Readonly<Partial<Record<RuntimeAuthMethod, number>>>,
): RuntimeAdapter {
  return {
    id,
    displayName: id,
    vendor: 'test',
    credentialTtlMs,
    loginCommand: () => [id, 'login'],
    getAuthMethods: () => [obtainedVia],
    beginAuth: async () => {
      throw new Error('unused');
    },
    completeAuth: async () => credential(id, obtainedVia),
    createCredentialFromSecret: async () => credential(id, obtainedVia),
    injectCredential: async () => {},
  };
}

const noopPty: HelperProcessStream = {
  ref: 'pty-1',
  onData: () => {},
  write: () => {},
  resize: () => {},
  onExit: () => {},
  detach: () => {},
  kill: async () => {},
};

/** Drive the real `completeAuth` path (session store → adapter → storeCredential). */
async function completeAuthWith(adapter: RuntimeAdapter, method: RuntimeAuthMethod) {
  const sessions = new AuthSessionStore();
  const { service: credentials, stored } = capturingCredentials();
  const svc = new RuntimeApplicationService(
    registryWith([adapter]),
    undefined as never, // helper — the session is pre-seeded below
    undefined as never, // settings
    sessions,
    credentials as never,
    undefined as never, // uow
    clock,
    undefined as never, // ids
  );
  let disposed = false;
  const session: AuthHelperSession = {
    pty: noopPty,
    homeDir: '/tmp/helper-home',
    dispose: async () => {
      disposed = true;
    },
  };
  sessions.put({
    challengeRef: 'ref-1',
    runtimeId: adapter.id,
    session,
    challenge: AuthChallenge.create({
      challengeRef: 'ref-1',
      method,
      kind: method === 'oauth-device' ? 'device-code' : 'paste-prompt',
      instructions: 'test',
    }),
    expiresAt: new Date(NOW_MS + 15 * 60_000),
    status: 'pending',
  });
  await svc.completeAuth(adapter.id, 'ref-1', 'pasted-code');
  expect(disposed).toBe(true);
  return stored;
}

describe('credential expiry comes from RuntimeAdapter.credentialTtlMs (04 §3)', () => {
  it('the two built-ins declare EXACTLY the lifetimes that used to be platform constants', () => {
    expect(new CodexAdapter().credentialTtlMs).toEqual({ 'oauth-device': HOUR });
    expect(new ClaudeCodeAdapter().credentialTtlMs).toEqual({ 'setup-token': YEAR });
    // neither declares one for api-key — an API key has no vendor expiry.
    expect(new CodexAdapter().credentialTtlMs?.['api-key']).toBeUndefined();
    expect(new ClaudeCodeAdapter().credentialTtlMs?.['api-key']).toBeUndefined();
  });

  it('codex oauth-device still stores now+1h (no regression)', async () => {
    const codexTtl = new CodexAdapter().credentialTtlMs;
    const stored = await completeAuthWith(
      stubAdapter('codex', 'oauth-device', codexTtl),
      'oauth-device',
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].expiresAt?.toISOString()).toBe(at(HOUR));
  });

  it('claude setup-token still stores now+1y (no regression)', async () => {
    const claudeTtl = new ClaudeCodeAdapter().credentialTtlMs;
    const stored = await completeAuthWith(
      stubAdapter('claude-code', 'setup-token', claudeTtl),
      'setup-token',
    );
    expect(stored[0].expiresAt?.toISOString()).toBe(at(YEAR));
  });

  it('a THIRD-PARTY oauth-device runtime gets ITS OWN ttl — not the Codex hour (the bug)', async () => {
    const eightHours = 8 * HOUR;
    const stored = await completeAuthWith(
      stubAdapter('acme', 'oauth-device', { 'oauth-device': eightHours }),
      'oauth-device',
    );
    expect(stored[0].expiresAt?.toISOString()).toBe(at(eightHours));
    // the point of the fix: it is NOT 1h anymore.
    expect(stored[0].expiresAt?.getTime()).not.toBe(NOW_MS + HOUR);
  });

  it('an adapter that declares NO ttl for the method stores null (no platform expiry)', async () => {
    const stored = await completeAuthWith(stubAdapter('nottl', 'oauth-device'), 'oauth-device');
    expect(stored[0].expiresAt).toBeNull();
  });

  it('api-key is not hard-coded to null either — an adapter may declare a ttl for it', async () => {
    const week = 7 * 24 * HOUR;
    const { service: credentials, stored } = capturingCredentials();
    const rotating = stubAdapter('rotating', 'api-key', { 'api-key': week });
    const svc = new RuntimeApplicationService(
      registryWith([rotating, stubAdapter('plainkey', 'api-key')]),
      undefined as never,
      undefined as never,
      undefined as never,
      credentials as never,
      undefined as never,
      clock,
      undefined as never,
    );

    await svc.submitSecret('rotating', 'whatever-secret');
    expect(stored[0].expiresAt?.toISOString()).toBe(at(week));

    await svc.submitSecret('plainkey', 'whatever-secret');
    expect(stored[1].expiresAt).toBeNull();
  });
});
