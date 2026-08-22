import { describe, it, expect } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { CreateSandboxInput, SandboxProviderCapabilities } from '@platform/contracts';
import { FakeProvider, FULL_CAPS as FULL, harness as makeHarness } from './_harness';

/**
 * Capabilities協商 (docs/backend/04 §5): the two rules that have a REAL platform branch
 * today — 「创建前静态校验」 and the 「spawnTty=false ⇒ 创建时即拒绝」 row of §2.5 — plus the
 * 「能力发现」 endpoint's application half. This is also the FIRST producer of
 * `UNSUPPORTED_CAPABILITY`: before this slice the error code had no throw site at all.
 */
function provider(name: string, caps: SandboxProviderCapabilities): FakeProvider {
  return new FakeProvider(name, caps);
}

function harness(providers: FakeProvider[], defaultProvider = providers[0].name) {
  return makeHarness({ providers, defaultProvider });
}

const base: CreateSandboxInput = { projectId: 'prj-1', runtime: 'claude-code' };

/** Assert the rejection is the contract error mapped through 04 §4 (409 + code). */
async function expectUnsupported(p: Promise<unknown>): Promise<HttpException> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(HttpException);
  const http = e as HttpException;
  expect(http.getStatus()).toBe(409);
  expect(http.getResponse()).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  return http;
}

describe('create-time capability negotiation (04 §5 创建前静态校验)', () => {
  it('rejects a request that requires a capability the provider lacks — WITHOUT scheduling', async () => {
    const noSnapshot = provider('aio', { ...FULL, snapshot: false });
    const h = harness([noSnapshot]);

    const err = await expectUnsupported(h.service.create({ ...base, require: { snapshot: true } }));
    expect(err.message).toMatch(/snapshot/);

    // 「不进调度队列」: no provider call, no project lookup, no persisted row.
    expect(noSnapshot.calls).toEqual([]);
    expect(h.projectLookups()).toBe(0);
    expect(h.repo.store.size).toBe(0);
  });

  it('lets the same request through on a provider that DOES advertise the bit', async () => {
    const withSnapshot = provider('aio', FULL);
    const h = harness([withSnapshot]);

    const dto = await h.service.create({ ...base, require: { snapshot: true } });
    expect(dto.status).toBe('pending');
    expect(h.projectLookups()).toBe(1);
  });

  it('checks every requested bit, not just snapshot', async () => {
    const p = provider('aio', { ...FULL, pauseResume: false, updateResources: false });
    const h = harness([p]);

    await expectUnsupported(h.service.create({ ...base, require: { pauseResume: true } }));
    await expectUnsupported(h.service.create({ ...base, require: { updateResources: true } }));
    // `false` means "do not care", not "must be false"
    const dto = await h.service.create({ ...base, require: { pauseResume: false } });
    expect(dto.status).toBe('pending');
  });

  it('the requirement is evaluated against the REQUESTED provider, not the default', async () => {
    const aio = provider('aio', FULL);
    const lite = provider('boxlite', { ...FULL, snapshot: false });
    const h = harness([aio, lite], 'aio');

    await expectUnsupported(
      h.service.create({ ...base, provider: 'boxlite', require: { snapshot: true } }),
    );
    expect(lite.calls).toEqual([]);
    // the default provider supports it, so the same request without `provider` passes
    await h.service.create({ ...base, require: { snapshot: true } });
  });
});

describe('spawnTty is required unconditionally (04 §2.5 spawnTty row)', () => {
  it('refuses to create on a provider that cannot spawn a TTY, even with no `require`', async () => {
    const headlessOnly = provider('noTty', { ...FULL, spawnTty: false });
    const h = harness([headlessOnly]);

    const err = await expectUnsupported(h.service.create(base));
    expect(err.message).toMatch(/spawnTty/);
    expect(err.message).toMatch(/TTY/);
    expect(headlessOnly.calls).toEqual([]);
    expect(h.repo.store.size).toBe(0);
  });

  it('a TTY-capable provider is unaffected', async () => {
    const ok = provider('aio', FULL);
    const h = harness([ok]);
    await expect(h.service.create(base)).resolves.toMatchObject({ status: 'pending' });
  });
});

describe('capability discovery (04 §5 能力发现)', () => {
  it('projects the whole registry — all 6 bits per provider + which one is default', () => {
    const aio = provider('aio', FULL);
    const lite = provider('boxlite', { ...FULL, updateResources: false, snapshot: false });
    const h = harness([aio, lite], 'aio');

    expect(h.service.listProviders()).toEqual([
      { name: 'aio', capabilities: FULL, isDefault: true },
      {
        name: 'boxlite',
        capabilities: { ...FULL, updateResources: false, snapshot: false },
        isDefault: false,
      },
    ]);
  });

  it('is REGISTRY-driven: a provider registered after boot appears with no code change', () => {
    const aio = provider('aio', FULL);
    const h = harness([aio], 'aio');
    expect(h.service.listProviders().map((p) => p.name)).toEqual(['aio']);

    // exactly what an out-of-tree module does in its onModuleInit
    const acme = provider('acme', { ...FULL, pauseResume: false });
    h.registry.register(acme);

    const rows = h.service.listProviders();
    expect(rows.map((p) => p.name)).toEqual(['aio', 'acme']);
    expect(rows.find((p) => p.name === 'acme')?.capabilities.pauseResume).toBe(false);
    expect(rows.find((p) => p.name === 'acme')?.isDefault).toBe(false);
  });
});
