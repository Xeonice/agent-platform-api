import { describe, it, expect } from 'vitest';
import { runHalfStub } from '../_run-half';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { Clock } from '@platform/shared-kernel';
import type {
  ApiKeyFormatVerdict,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeCredential,
} from '@platform/contracts';
import { RuntimeApplicationService } from '../../src/application/runtime-application.service';
import { CodexAdapter } from '../../src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../src/infrastructure/adapters/claude-code/claude-code.adapter';

const clock: Clock = { now: () => new Date(1_700_000_000_000) };

function registryWith(adapters: RuntimeAdapter[]): RuntimeAdapterRegistry {
  const map = new Map(adapters.map((a) => [a.id, a]));
  return {
    register(a) {
      if (map.has(a.id)) throw new Error(`duplicate runtime adapter id '${a.id}'`);
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

/** A credential service stub capturing only what `submitSecret` → `storeCredential` needs. */
function fakeCredentials() {
  const stored: Array<{ runtimeId: string; maskedIdentifier: string }> = [];
  const service = {
    storeRuntimeCredential: async (input: { runtimeId: string; maskedIdentifier: string }) => {
      stored.push({ runtimeId: input.runtimeId, maskedIdentifier: input.maskedIdentifier });
      return { maskedIdentifier: input.maskedIdentifier };
    },
  };
  return { service, stored };
}

function makeService(
  registry: RuntimeAdapterRegistry,
  credentials: unknown,
): RuntimeApplicationService {
  return new RuntimeApplicationService(
    registry,
    undefined as never, // helper — unused by submitSecret
    undefined as never, // settings
    undefined as never, // sessions
    credentials as never, // credentials
    undefined as never, // uow
    undefined as never, // events
    clock,
    undefined as never, // ids
  );
}

const OPENAI_KEY = 'sk-proj-abcdefghijklmnop';
const ANTHROPIC_KEY = 'sk-ant-abcdefghijklmnop';
const BAD_KEY = 'nope-1234567890';

describe('submitSecret dispatches api-key FORMAT validation to the adapter (no runtimeId=== branch)', () => {
  it('codex validates via ITS adapter — accepts an sk- key, rejects a no-prefix key', async () => {
    const registry = registryWith([new CodexAdapter(), new ClaudeCodeAdapter()]);
    const { service } = fakeCredentials();
    const svc = makeService(registry, service);

    const ok = await svc.submitSecret('codex', 'api-key', OPENAI_KEY);
    expect(ok.maskedIdentifier.startsWith('sk-')).toBe(true);

    await expect(svc.submitSecret('codex', 'api-key', BAD_KEY)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('claude validates via ITS adapter (reversed) — accepts sk-ant-, rejects the OpenAI key codex accepts', async () => {
    const registry = registryWith([new CodexAdapter(), new ClaudeCodeAdapter()]);
    const { service } = fakeCredentials();
    const svc = makeService(registry, service);

    const ok = await svc.submitSecret('claude-code', 'api-key', ANTHROPIC_KEY);
    expect(ok.maskedIdentifier.startsWith('sk-')).toBe(true);

    // the SAME OpenAI key codex accepted is rejected by claude's adapter — pure dispatch.
    await expect(svc.submitSecret('claude-code', 'api-key', OPENAI_KEY)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('IMAGINARY third-party adapter: api-key validation + store go through with NO service change', async () => {
    // A new runtime added by writing ONLY an adapter (validateApiKey + createCredentialFromSecret)
    // and registering it. submitSecret dispatches to it verbatim — proving the extension point.
    const acme: RuntimeAdapter = {
      // ⛔ 运行半边本测试不涉及，但**契约要求它在** —— 见 `_run-half.ts`。
      ...runHalfStub,
      id: 'acme',
      displayName: 'Acme',
      vendor: 'Acme Inc',
      loginCommand: () => ['acme', 'login'],
      getAuthMethods: () => ['api-key'],
      validateApiKey: (secret: string): ApiKeyFormatVerdict =>
        secret.startsWith('acme-') && secret.length >= 12
          ? { ok: true }
          : { ok: false, reason: 'missing acme- prefix' },
      createCredentialFromSecret: async (_method, secret): Promise<RuntimeCredential> => {
        const cred: RuntimeCredential = {
          runtimeId: 'acme',
          obtainedVia: 'api-key',
          maskedIdentifier: `acme-…${secret.slice(-4)}`,
          issuedAt: '',
          env: { ACME_API_KEY: secret },
          credentialFiles: [],
          zeroize(): void {
            cred.env = undefined;
          },
        };
        return cred;
      },
      beginAuth: async () => {
        throw new Error('unused');
      },
      completeAuth: async () => {
        throw new Error('unused');
      },
      injectCredential: async () => {},
    };
    const registry = registryWith([new CodexAdapter(), new ClaudeCodeAdapter(), acme]);
    const { service, stored } = fakeCredentials();
    const svc = makeService(registry, service);

    const ok = await svc.submitSecret('acme', 'api-key', 'acme-1234567890');
    expect(ok.maskedIdentifier).toBe('acme-…7890');
    expect(stored).toEqual([{ runtimeId: 'acme', maskedIdentifier: 'acme-…7890' }]);

    await expect(svc.submitSecret('acme', 'api-key', 'wrong-key')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("⛔ access-token-paste reaches the adapter — the contract's OTHER secret method", async () => {
    // ⛔ THE WHOLE PATH WAS WELDED SHUT. `createCredentialFromSecret` has always taken
    //    `'api-key' | 'access-token-paste'`, but the wire schema was
    //    `z.literal('api-key')`, `toRuntimeDto` filtered the method out of
    //    `authMethods`, the controller dropped `dto.method`, and this service passed a
    //    hard-coded `'api-key'`. Four gates, no error anywhere: the method simply never
    //    arrived. This case drives the value the adapter really receives.
    const seen: string[] = [];
    const paster: RuntimeAdapter = {
      ...runHalfStub,
      id: 'paster',
      displayName: 'Paster',
      vendor: 'X',
      loginCommand: () => ['paster', 'login'],
      getAuthMethods: () => ['access-token-paste'],
      // ⚠️ NO `validateApiKey` here would make the point weakly; declaring one that
      //    REJECTS EVERYTHING makes it precisely: an api-key format check must not run
      //    over a pasted access token, or a perfectly good credential is refused for
      //    failing to look like a different kind of secret.
      validateApiKey: (): ApiKeyFormatVerdict => ({ ok: false, reason: 'not an api key' }),
      createCredentialFromSecret: async (method, secret): Promise<RuntimeCredential> => {
        seen.push(method);
        const cred: RuntimeCredential = {
          runtimeId: 'paster',
          obtainedVia: method,
          maskedIdentifier: `paste-…${secret.slice(-4)}`,
          issuedAt: '',
          credentialFiles: [],
          env: { PASTER_TOKEN: secret },
          zeroize(): void {
            cred.env = undefined;
          },
        };
        return cred;
      },
      beginAuth: async () => {
        throw new Error('unused');
      },
      completeAuth: async () => {
        throw new Error('unused');
      },
      injectCredential: async () => {},
    };
    const { service, stored } = fakeCredentials();
    const svc = makeService(registryWith([paster]), service);

    const ok = await svc.submitSecret('paster', 'access-token-paste', 'tok-abcd1234');
    expect(ok.maskedIdentifier).toBe('paste-…1234');
    expect(seen).toEqual(['access-token-paste']); // ← the method really travelled
    expect(stored).toEqual([{ runtimeId: 'paster', maskedIdentifier: 'paste-…1234' }]);

    // and the door still refuses a method this adapter never offered
    await expect(svc.submitSecret('paster', 'api-key', 'tok-abcd1234')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('a runtime whose adapter has no createCredentialFromSecret → BadRequest (no api-key support)', async () => {
    const noApiKey: RuntimeAdapter = {
      // ⛔ 运行半边本测试不涉及，但**契约要求它在** —— 见 `_run-half.ts`。
      ...runHalfStub,
      id: 'noapikey',
      displayName: 'NoApiKey',
      vendor: 'X',
      loginCommand: () => ['x', 'login'],
      getAuthMethods: () => ['oauth-device'],
      beginAuth: async () => {
        throw new Error('unused');
      },
      completeAuth: async () => {
        throw new Error('unused');
      },
      injectCredential: async () => {},
    };
    const svc = makeService(registryWith([noApiKey]), fakeCredentials().service);
    await expect(svc.submitSecret('noapikey', 'api-key', 'anything')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
