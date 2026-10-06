import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { asProjectId, asSandboxId } from '@platform/shared-kernel';
import {
  ProjectAccessError,
  SandboxProviderError,
  SandboxProviderErrorCode,
} from '@platform/contracts';
import type { InjectableRuntimeCredential, SandboxHandle } from '@platform/contracts';
import { Sandbox } from '../../../packages/modules/sandbox/src/domain/entities/sandbox.entity';
import { harness, waitForStatus } from '../../support/sandbox-rig';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const credential = (): InjectableRuntimeCredential => ({
  runtimeId: 'claude-code',
  obtainedVia: 'setup-token',
  issuedAt: '2026-10-05T00:00:00Z',
  env: { CLAUDE_CODE_OAUTH_TOKEN: 'secret' },
  credentialFiles: [],
  zeroize() {
    /* fixture owns no real secret */
  },
});

afterEach(() => vi.useRealTimers());

describe('delete cancellation at suspended provisioning boundaries', () => {
  it.each(['pending', 'scheduling', 'preparing-workspace', 'creating'] as const)(
    'deletes a recovered %s record and releases its registration',
    async (status) => {
      const h = harness();
      const sandbox = Sandbox.create({
        id: asSandboxId('recovered'),
        projectId: asProjectId('prj-1'),
        runtime: 'claude-code',
        provider: h.provider.name,
        imageRef: '',
        headless: false,
        timeoutMinutes: null,
        idleTimeoutSec: 1800,
        now: h.clock.now(),
      });
      for (const step of ['scheduling', 'preparing-workspace', 'creating'] as const) {
        if (sandbox.status === status) break;
        sandbox.transitionTo(step, 'scheduler', h.clock.now());
      }
      await h.resources.reserve(
        { sandboxId: sandbox.id, quota: { cores: 1, ramMb: 512, diskMb: 1024 } },
        (tx) => h.repo.saveSync(tx, sandbox),
      );
      await h.service.destroy(sandbox.id);
      expect((await h.repo.findById(sandbox.id))?.status).toBe('destroyed');
      expect((await h.allocations.listAll())[0].isActive).toBe(false);
      await expect(h.service.get(sandbox.id)).rejects.toBeInstanceOf(HttpException);
      await h.service.destroy(sandbox.id);
      expect(h.wsCalls.filter((call) => call.startsWith('cleanup:'))).toHaveLength(1);
    },
  );

  it('waits for a suspended workspace copy before cleanup and never creates an instance', async () => {
    const h = harness();
    const entered = deferred<void>();
    const release = deferred<void>();
    const prepare = h.workspace.prepare.bind(h.workspace);
    h.workspace.prepare = async (...args) => {
      entered.resolve();
      await release.promise;
      return prepare(...args);
    };
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await entered.promise;
    const deletion = h.service.destroy(dto.id);
    await tick();
    expect(h.wsCalls.some((call) => call.startsWith('cleanup:'))).toBe(false);
    release.resolve();
    await deletion;
    expect(h.provider.calls).not.toContain('create');
    expect((await h.repo.findById(asSandboxId(dto.id)))?.status).toBe('destroyed');
    expect(h.bootstrapInputs).toHaveLength(0);
  });

  it('records and removes a late provider.create handle rather than starting it', async () => {
    const h = harness();
    const entered = deferred<void>();
    const created = deferred<SandboxHandle>();
    h.provider.create = async () => {
      entered.resolve();
      return created.promise;
    };
    const destroyed: SandboxHandle[] = [];
    h.provider.destroy = async (handle) => {
      destroyed.push(handle);
    };
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await entered.promise;
    const deletion = h.service.destroy(dto.id);
    await tick();
    created.resolve({ provider: h.provider.name, providerSandboxId: 'late-instance' });
    await deletion;
    expect(destroyed).toEqual([
      { provider: h.provider.name, providerSandboxId: 'late-instance', providerState: undefined },
    ]);
    expect(h.provider.calls).not.toContain('start');
    expect((await h.repo.findById(asSandboxId(dto.id)))?.status).toBe('destroyed');
    expect((await h.allocations.listAll())[0].isActive).toBe(false);
  });

  it('a late start completion cannot resurrect a deleted task or bootstrap its Agent', async () => {
    const h = harness();
    const entered = deferred<void>();
    const started = deferred<void>();
    h.provider.start = async () => {
      entered.resolve();
      await started.promise;
    };
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await entered.promise;
    await h.service.destroy(dto.id, { force: true });
    started.resolve();
    await tick();
    expect((await h.repo.findById(asSandboxId(dto.id)))?.status).toBe('destroyed');
    expect(h.installInputs).toHaveLength(0);
    expect(h.bootstrapInputs).toHaveLength(0);
  });

  it('concurrent deletion shares cleanup and force interrupts a stuck courtesy stop', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    const entered = deferred<void>();
    h.provider.stop = async () => {
      entered.resolve();
      await new Promise<void>(() => {
        /* wedged provider */
      });
    };
    const first = h.service.destroy(dto.id, { keepVolume: true });
    await entered.promise;
    const second = h.service.destroy(dto.id, { force: true, keepVolume: true });
    await Promise.all([first, second]);
    expect(h.provider.calls.filter((call) => call === 'destroy')).toHaveLength(1);
    expect(h.retainedRegistrations).toHaveLength(1);
  });
});

describe('failure operation and credential injection revalidation', () => {
  it.each(['workspace', 'provider'] as const)(
    'bounds cancellation of a wedged %s and cleans its late result after project deletion',
    async (stage) => {
      const h = harness();
      const entered = deferred<void>();
      const release = deferred<void>();
      if (stage === 'workspace') {
        const prepare = h.workspace.prepare.bind(h.workspace);
        h.workspace.prepare = async (...args) => {
          entered.resolve();
          await release.promise;
          return prepare(...args);
        };
      } else {
        h.provider.create = async () => {
          entered.resolve();
          await release.promise;
          return { provider: h.provider.name, providerSandboxId: 'late-cancelled' };
        };
      }
      const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
      await entered.promise;
      vi.useFakeTimers();
      const deletion = h.service.destroy(dto.id).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(await deletion).toBeInstanceOf(HttpException);
      expect(await h.service.get(dto.id)).toMatchObject({
        status: 'failed',
        failureCode: 'TIMEOUT',
        failureOperation: 'destroy',
      });
      expect((await h.allocations.listAll())[0]?.isActive).toBe(false);
      h.uow.run((tx) => h.repo.deleteByProjectSync(tx, asProjectId('prj-1')));
      release.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.wsCalls).toContain(`cleanup:${dto.id}:false`);
      if (stage === 'provider') expect(h.provider.calls).toContain('destroy');
      expect(h.provider.calls).not.toContain('start');
      expect((await h.repo.findAll()).length).toBe(0);
    },
  );

  it.each([
    ['PROJECT_NOT_FOUND', 404],
    ['PROJECT_NOT_READY', 409],
  ] as const)(
    'revalidates %s after asynchronous admission before any transactional write',
    async (code, status) => {
      const h = harness();
      const entered = deferred<void>();
      const release = deferred<void>();
      const summary = h.imageFacade.findTaskImageSummary.bind(h.imageFacade);
      h.imageFacade.findTaskImageSummary = async (id) => {
        entered.resolve();
        await release.promise;
        return summary(id);
      };
      const creating = h.service
        .create({ projectId: 'prj-1', runtime: 'claude-code' })
        .catch((error: unknown) => error);
      await entered.promise;
      h.projectFacade.assertCanCreateTaskSync = () => {
        throw new ProjectAccessError(code, 'project changed during admission');
      };
      release.resolve();
      const error = await creating;
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(status);
      expect((error as HttpException).getResponse()).toMatchObject({
        code,
        retryable: false,
        sideEffectFree: true,
      });
      expect((await h.repo.findAll()).length).toBe(0);
      expect(await h.allocations.listAll()).toEqual([]);
      expect(h.publishedEvents).toEqual([]);
      expect(h.provider.calls).not.toContain('create');
    },
  );
  it('a hanging force removal settles with TIMEOUT and permits a fresh successful retry', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    vi.useFakeTimers();
    h.provider.destroy = async () =>
      new Promise<void>(() => {
        /* wedged remove */
      });
    const failure = h.service.destroy(dto.id, { force: true }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await failure).toBeInstanceOf(HttpException);
    expect(await h.service.get(dto.id)).toMatchObject({
      status: 'failed',
      failureCode: 'TIMEOUT',
      failureOperation: 'destroy',
    });
    h.provider.destroy = async () => {
      /* retry succeeded */
    };
    await h.service.destroy(dto.id, { force: true });
    expect((await h.repo.findById(asSandboxId(dto.id)))?.status).toBe('destroyed');
  });
  it('stop and destroy failures persist their own codes and operation, with teardown releasing registration', async () => {
    const h = harness();
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    h.provider.stop = async () => {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        'provider offline',
      );
    };
    await expect(h.service.stop(dto.id)).rejects.toBeInstanceOf(HttpException);
    expect(await h.service.get(dto.id)).toMatchObject({
      status: 'failed',
      failureCode: 'PROVIDER_UNAVAILABLE',
      failureOperation: 'stop',
      hasRun: true,
    });
    h.provider.destroy = async () => {
      throw new SandboxProviderError(SandboxProviderErrorCode.TIMEOUT, 'remove timeout');
    };
    await expect(h.service.destroy(dto.id)).rejects.toBeInstanceOf(HttpException);
    expect(await h.service.get(dto.id)).toMatchObject({
      status: 'failed',
      failureCode: 'TIMEOUT',
      failureOperation: 'destroy',
      hasRun: true,
    });
    expect((await h.allocations.listAll())[0].isActive).toBe(false);
  });

  it('revocation after decryption but before environment delivery starts unauthenticated', async () => {
    const h = harness({ credential: credential() });
    const prepare = h.credentials.prepareRuntimeCredential.bind(h.credentials);
    h.credentials.prepareRuntimeCredential = async (runtimeId) => {
      const prepared = await prepare(runtimeId);
      h.revokedCredentials.add(prepared.credentialId);
      return prepared;
    };
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'running');
    expect(h.provider.lastContext?.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(h.injections).toHaveLength(0);
    expect(h.calls).not.toContain('injectCredential');
  });

  it('revocation while provider.start is suspended prevents file injection and compensates the instance', async () => {
    const h = harness({ credential: credential() });
    const entered = deferred<void>();
    const release = deferred<void>();
    h.provider.start = async () => {
      entered.resolve();
      await release.promise;
    };
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await entered.promise;
    h.revokedCredentials.add('cred-claude-code');
    release.resolve();
    await waitForStatus(h.service, dto.id, 'failed');
    expect(await h.service.get(dto.id)).toMatchObject({
      failureCode: 'AUTH_REJECTED',
      failureOperation: 'provision',
    });
    expect(h.calls).not.toContain('injectCredential');
    expect(h.provider.calls).toContain('destroy');
    expect(h.bootstrapInputs).toHaveLength(0);
  });
});
