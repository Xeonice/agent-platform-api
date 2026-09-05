import { mkdtempSync, rmSync } from 'node:fs';
import { runHalfStub } from '../../../../packages/modules/runtime/test/_run-half';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { Inject, Module } from '@nestjs/common';
import type { INestApplication, OnModuleInit } from '@nestjs/common';
import {
  IMAGE_SPEC_REGISTRY,
  PROJECT_FACADE,
  RUNTIME_ADAPTER_REGISTRY,
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
  formatImageRef,
  parseImageRef,
} from '@platform/contracts';
import type {
  ApiKeyFormatVerdict,
  ImageSpecManifest,
  ImageSpecProvider,
  ImageSpecRegistry,
  ProcessSpec,
  ProcessStream,
  ProviderDto,
  ProviderRegistry,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeAuthMethod,
  RuntimeCredential,
  RuntimeDto,
  SandboxHandle,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderContext,
  SandboxRuntimeStatus,
  ValidationResult,
} from '@platform/contracts';
import { ImageApplicationService } from '@platform/image';
import { AppModule } from '../../src/app.module';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import { useEnv } from './_env';
import { FakeExecProcessStream, fakeProjectFacade, fakeWorkspace } from './_fakes';

/**
 * OUT-OF-TREE REGISTRATION ACCEPTANCE (docs/backend/04 §8 方式一: DI Token + 动态模块).
 *
 * This is the judge of whether "可注册" is real. `AcmeExtensionModule` below is written
 * exactly as a third-party npm package would write it: it is NOT listed in any built-in
 * module's `providers`, no registry constructor is edited, no `switch` gains a case. It
 * only injects the two registry TOKENS and calls `register()` from its own
 * `onModuleInit` — and from that moment the platform must treat its provider and its
 * runtime adapter as first-class:
 *
 *   - `GET /api/providers` lists the provider with its capabilities (04 §5 能力发现);
 *   - `POST /api/sandboxes {provider:'acme'}` provisions THROUGH it;
 *   - capability negotiation applies to it like any built-in (04 §5 / §2.5);
 *   - `GET /api/runtimes` lists the adapter and `POST .../credentials/secret` stores a
 *     credential whose expiry comes from the ADAPTER's own `credentialTtlMs` (04 §3);
 *   - a second registration of the same name/id fails fast (04 §8).
 *
 * ⚠️ IT NOW COVERS THE **THIRD** REGISTRY TOO. `IMAGE_SPEC_REGISTRY` was a bare Symbol
 * with no interface, no implementation and no binding until the image slice — so
 * 「provider / runtime / 镜像三层可注册」 (product 19 §1 原则 5) was two thirds true and
 * nothing said so. `AcmeImageSpec` below registers through the same public token, and
 * `POST /api/images` then resolves through IT.
 *
 * Runs on in-memory doubles for workspace/project only — no docker, no daemon.
 */
const ACME_CAPS: SandboxProviderCapabilities = {
  spawnTty: true,
  volumeMount: true,
  updateResources: false,
  pauseResume: true,
  snapshot: false,
  watchEvents: false,
  headlessTask: false,
};

/** A third-party provider — implements the 6 required methods, nothing platform-side. */
class AcmeSandboxProvider implements SandboxProvider {
  // ⚠️ 显式标 `string`：不标的话它被推断成字面量类型 `'acme'`，子类
  //    `HeadlessOnlyProvider` 就覆盖不了（TS2416）。契约上它本就是 `string`。
  readonly name: string = 'acme';
  readonly capabilities = ACME_CAPS;
  readonly calls: string[] = [];
  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    this.calls.push(`create:${ctx.sandboxId}`);
    return { provider: this.name, providerSandboxId: `acme-${ctx.sandboxId}` };
  }
  async start(): Promise<void> {
    this.calls.push('start');
  }
  async stop(): Promise<void> {
    this.calls.push('stop');
  }
  async destroy(): Promise<void> {
    this.calls.push('destroy');
  }
  async inspect(): Promise<SandboxRuntimeStatus> {
    return { lifecycleState: 'instance_running' };
  }
  async spawn(_h: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> {
    this.calls.push(spec.tty ? 'spawn:tty' : 'spawn:exec');
    // the `starting` 段 really execs through the third-party provider (install probe,
    // credential injection, tmux self-check), so a one-shot exec must TERMINATE.
    return new FakeExecProcessStream('acme 1.0.0', 0);
  }
}

/** A third-party provider that cannot give a TTY — must be refused at create (04 §2.5). */
class HeadlessOnlyProvider extends AcmeSandboxProvider {
  override readonly name = 'acme-headless';
  override readonly capabilities: SandboxProviderCapabilities = {
    ...ACME_CAPS,
    spawnTty: false,
  };
}

const ACME_KEY_TTL_MS = 30 * 24 * 60 * 60_000;

/** A third-party runtime adapter, api-key only, with its OWN credential lifetime. */
const acmeAdapter: RuntimeAdapter = {
  // ⛔ 运行半边本测试不涉及，但**契约要求它在** —— 见 `_run-half.ts`。
  ...runHalfStub,
  id: 'acme-agent',
  displayName: 'Acme Agent',
  vendor: 'Acme Inc',
  // NOT one of the built-in vendors' lifetimes — the platform must use THIS number.
  credentialTtlMs: { 'api-key': ACME_KEY_TTL_MS },
  loginCommand: () => ['acme', 'login'],
  getAuthMethods: (): RuntimeAuthMethod[] => ['api-key'],
  validateApiKey: (secret: string): ApiKeyFormatVerdict =>
    secret.startsWith('acme-') ? { ok: true } : { ok: false, reason: 'missing acme- prefix' },
  createCredentialFromSecret: async (_m, secret): Promise<RuntimeCredential> => {
    const cred: RuntimeCredential = {
      runtimeId: 'acme-agent',
      obtainedVia: 'api-key',
      maskedIdentifier: `acme-…${secret.slice(-4)}`,
      issuedAt: new Date().toISOString(),
      credentialFiles: [],
      env: { ACME_API_KEY: secret },
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

/**
 * A third-party `ImageSpecProvider` (04 §7). Resolves offline — the point of the
 * clause is the REGISTRATION path, not the network — and declares tmux so its
 * manifests are selectable.
 */
const acmeImageSpec: ImageSpecProvider = {
  name: 'acme-spec',
  async resolve(ref: string) {
    const parsed = parseImageRef(ref);
    const reference = parsed.digest ?? parsed.tag ?? 'latest';
    return {
      ref: formatImageRef(parsed.name, reference),
      digest: `sha256:${'ac3'.repeat(21)}e`,
      entrypoint: ['/bin/sh'],
      resolvedAt: '2026-08-25T00:00:00.000Z',
      manifest: {
        name: parsed.name,
        version: reference,
        baseImage: parsed.name,
        entrypointContract: { workdir: '/', entrypoint: ['/bin/sh'] },
        supportedRuntimes: ['acme-runtime'],
        resourceDefaults: { cores: 1, ramMb: 512, diskMb: 1024 },
        labelsRequired: ['platform.tmux'],
        // One constant layer for every ref: this provider answers the same bits for
        // everything, so the seeded root and any later image share a lineage by
        // construction. That keeps THIS spec about the registry seam (04 §8) instead
        // of quietly turning into a second lineage test.
        diffIds: [`sha256:${'ac7'.repeat(21)}f`],
      },
    };
  },
  validate(_manifest: ImageSpecManifest): ValidationResult {
    return { valid: true, errors: [], warnings: [] };
  },
};

const acmeProvider = new AcmeSandboxProvider();
const headlessProvider = new HeadlessOnlyProvider();

/**
 * THE out-of-tree module. Note what it does NOT do: it does not import any built-in
 * module's internals, does not appear in `SandboxModule`/`RuntimeModule`, and does not
 * construct a registry. It injects the public tokens and registers.
 */
@Module({})
class AcmeExtensionModule implements OnModuleInit {
  constructor(
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
    @Inject(RUNTIME_ADAPTER_REGISTRY) private readonly runtimes: RuntimeAdapterRegistry,
    @Inject(IMAGE_SPEC_REGISTRY) private readonly imageSpecs: ImageSpecRegistry,
  ) {}

  onModuleInit(): void {
    this.providers.register(acmeProvider);
    this.providers.register(headlessProvider);
    this.runtimes.register(acmeAdapter);
    // `default: true` moves the platform's resolver onto this one, mirroring
    // `register(x, { default: true })` on the sandbox registry.
    this.imageSpecs.register(acmeImageSpec, { default: true });
  }
}

let app: INestApplication;
let dataRoot: string;
let restoreEnv: () => void;
let acmeManifest: { manifest: { id: string; digest: string } };

beforeAll(async () => {
  dataRoot = mkdtempSync(resolve(tmpdir(), 'registry-ext-'));
  restoreEnv = useEnv({
    DATABASE_URL: ':memory:',
    PLATFORM_MASTER_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
    DATA_ROOT: dataRoot,
    ACCESS_PASSCODE: undefined,
  });

  const moduleRef = await Test.createTestingModule({
    // the third-party module sits BESIDE the app, exactly like an installed plugin
    imports: [AppModule, AcmeExtensionModule],
  })
    // only the fs/git edges are doubled; BOTH registries are the real ones
    .overrideProvider(WORKSPACE_PREPARER)
    .useValue(fakeWorkspace)
    .overrideProvider(PROJECT_FACADE)
    .useValue(fakeProjectFacade)
    .compile();
  app = moduleRef.createNestApplication();
  configurePlatformApp(app);
  await app.init();
  await app.listen(0);
  // Resolved BY THE THIRD-PARTY SPEC PROVIDER — the create door needs a registered,
  // active image now (04 §7 时刻③), and this proves the third registry is load-bearing
  // rather than merely present.
  const registered = await app
    .get(ImageApplicationService)
    .registerImage(process.env.SANDBOX_DEFAULT_IMAGE ?? 'alpine:3.20');
  expect(registered.created).toBe(true);
  acmeManifest = registered;
});

afterAll(async () => {
  await app?.close();
  restoreEnv?.();
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

async function waitForStatus(id: string, status: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const res = await request(app.getHttpServer()).get(`/api/sandboxes/${id}`);
    if (res.body?.status === status) return;
    if (res.body?.status === 'failed') throw new Error(`sandbox ${id} failed`);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`sandbox ${id} never reached ${status}`);
}

describe('an out-of-tree module registers a provider + a runtime adapter (04 §8)', () => {
  it('GET /api/providers lists the built-ins AND the registered third party', async () => {
    const res = await request(app.getHttpServer()).get('/api/providers').expect(200);
    const rows = res.body as ProviderDto[];
    const names = rows.map((p) => p.name);

    expect(names).toContain('aio');
    expect(names).toContain('boxlite');
    // NOTHING in the built-in wiring mentions `acme` — it is here purely because the
    // extension module called register().
    expect(names).toContain('acme');

    const acme = rows.find((p) => p.name === 'acme')!;
    expect(acme.capabilities).toEqual(ACME_CAPS); // all 6 bits, verbatim
    // ⚠️ 这里断的是「注册第三方**不会**抢走默认」，而不是「默认是 aio」——
    //    默认档位现在跟随宿主平台（macOS ⇒ boxlite，Linux ⇒ aio，见 provider-registry），
    //    写死 'aio' 等于把一台机器的巧合当成契约，换台机器就红。
    expect(acme.isDefault).toBe(false);
    const defaults = rows.filter((p) => p.isDefault).map((p) => p.name);
    expect(defaults).toHaveLength(1); // 恰好一个，不是零个也不是两个
    expect(['aio', 'boxlite']).toContain(defaults[0]);
  });

  it('POST /api/sandboxes provisions THROUGH the third-party provider', async () => {
    const before = acmeProvider.calls.length;
    const created = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: 'prj-acme', runtime: 'claude-code', provider: 'acme' })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.status).toBe('pending');

    await waitForStatus(id, 'running');
    // the application really drove the out-of-tree implementation — including the
    // `starting` 段, whose install probe / credential inject / tmux self-check all go
    // through the third party's own `spawn({tty:false})` (03 §4.3, 04 §2.3).
    const calls = acmeProvider.calls.slice(before);
    expect(calls.slice(0, 2)).toEqual([`create:${id}`, 'start']);
    expect(calls.slice(2).every((c) => c === 'spawn:exec')).toBe(true);
    expect(calls.length).toBeGreaterThan(2);

    await request(app.getHttpServer()).delete(`/api/sandboxes/${id}`).send({}).expect(204);
    expect(acmeProvider.calls).toContain('destroy');
  });

  it('capability negotiation applies to it: require:{snapshot} → 409 UNSUPPORTED_CAPABILITY', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({
        projectId: 'prj-acme',
        runtime: 'claude-code',
        provider: 'acme',
        require: { snapshot: true },
      })
      .expect(409);
    expect(res.body.code).toBe('UNSUPPORTED_CAPABILITY');

    // a bit it DOES advertise passes the same gate
    await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({
        projectId: 'prj-acme',
        runtime: 'claude-code',
        provider: 'acme',
        require: { pauseResume: true },
      })
      .expect(201);
  });

  it('a provider without spawnTty is refused at create (04 §2.5 spawnTty row)', async () => {
    const before = headlessProvider.calls.length;
    const res = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: 'prj-acme', runtime: 'claude-code', provider: 'acme-headless' })
      .expect(409);
    expect(res.body.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(res.body.message).toMatch(/spawnTty/);
    expect(headlessProvider.calls.length).toBe(before); // never scheduled
  });

  it('GET /api/runtimes lists the third-party adapter with its declared auth methods', async () => {
    const res = await request(app.getHttpServer()).get('/api/runtimes').expect(200);
    const runtimes = res.body as RuntimeDto[];
    expect(runtimes.map((r) => r.id)).toEqual(
      expect.arrayContaining(['codex', 'claude-code', 'acme-agent']),
    );
    const acme = runtimes.find((r) => r.id === 'acme-agent')!;
    expect(acme.displayName).toBe('Acme Agent');
    expect(acme.authMethods).toEqual(['api-key']);
    expect(acme.credentialStatus).toBe('none');
  });

  it('POST .../credentials/secret runs the ADAPTER validation and stores ITS ttl', async () => {
    // the adapter's own format rule rejects a wrong-prefix key
    await request(app.getHttpServer())
      .post('/api/runtimes/acme-agent/credentials/secret')
      .send({ method: 'api-key', secret: 'sk-not-an-acme-key' })
      .expect(401);

    const submittedAt = Date.now();
    const ok = await request(app.getHttpServer())
      .post('/api/runtimes/acme-agent/credentials/secret')
      .send({ method: 'api-key', secret: 'acme-key-1234567890' })
      .expect(200);
    expect(ok.body.maskedIdentifier).toBe('acme-…7890');

    // the stored expiry is the ADAPTER's 30 days — NOT a built-in vendor's lifetime and
    // not the platform's old "api-key ⇒ never expires" assumption.
    const res = await request(app.getHttpServer()).get('/api/runtimes').expect(200);
    const acme = (res.body as RuntimeDto[]).find((r) => r.id === 'acme-agent')!;
    expect(acme.credentials).toHaveLength(1);
    const expiresAt = Date.parse(acme.credentials[0].expiresAt!);
    expect(Math.abs(expiresAt - (submittedAt + ACME_KEY_TTL_MS))).toBeLessThan(60_000);
  });

  it('registering the same provider name / runtime id twice FAILS FAST (04 §8)', () => {
    const providers = app.get<ProviderRegistry>(SANDBOX_PROVIDER_REGISTRY);
    const runtimes = app.get<RuntimeAdapterRegistry>(RUNTIME_ADAPTER_REGISTRY);

    expect(() => providers.register(new AcmeSandboxProvider())).toThrow(/duplicate/i);
    expect(() => runtimes.register({ ...acmeAdapter })).toThrow(/duplicate/i);
    // and shadowing a built-in is refused just the same
    expect(() => runtimes.register({ ...acmeAdapter, id: 'codex' })).toThrow(/duplicate/i);
  });
});

/**
 * The third registry, proven the same way as the other two: nothing built-in was
 * edited, and the platform now resolves images through the out-of-tree provider.
 */
describe('IMAGE_SPEC_REGISTRY is a real extension point (04 §8 / §7)', () => {
  it('registers an image THROUGH the out-of-tree spec provider, digest and all', () => {
    // The digest is the third-party provider's, so this fails if the platform
    // silently fell back to its own built-in `oci` resolver.
    expect(acmeManifest.manifest.digest).toBe(`sha256:${'ac3'.repeat(21)}e`);
    expect(acmeManifest.manifest.id).toMatch(/\S/);
  });

  it('a duplicate spec-provider name fails fast, like the other two registries', () => {
    const registry = app.get<ImageSpecRegistry>(IMAGE_SPEC_REGISTRY);
    expect(() => registry.register(acmeImageSpec)).toThrow(/duplicate image-spec provider/i);
  });
});
