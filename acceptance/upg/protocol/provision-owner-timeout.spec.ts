import { assertDefined } from '../../support/assert-defined';
import 'reflect-metadata';
import { ClientRequest, createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  type ProviderRegistry,
  type SandboxProvider,
  type RuntimeBusinessAuthorityPort,
} from '@platform/contracts';
import { RuntimeOwnerServer } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-server';
import { RuntimeOwnerProviderRegistry } from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/owner-client';
import { RuntimeCredentialService } from '../../../packages/modules/credential/src/application/runtime-credential.service';
import { SqliteCredentialRepository } from '../../../packages/modules/credential/src/infrastructure/persistence/sqlite/credential.repository.impl';
import { SqliteCredentialSandboxBindingRepository } from '../../../packages/modules/credential/src/infrastructure/persistence/sqlite/credential-sandbox-binding.repository.impl';
import {
  explicitRuntimeBusinessAuthority,
  withRuntimeBusinessAuthority,
} from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/authority-context';
import { harness } from '../../support/sandbox-rig';
import { deferred, useEnv } from '../../support/strict-ports';
import { SqliteSandboxStartupProgress } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/sandbox-startup-progress.impl';

const authority: RuntimeBusinessAuthorityPort = {
  run: withRuntimeBusinessAuthority,
  current: explicitRuntimeBusinessAuthority,
};
const key = 'isolated-provision-transport-key-not-production';
/** Real HTTP, owner journal, business SQLite, filesystem, and workflow. Only the
 * external provider's delayed start is controlled; no native VM/model is claimed. */
async function fixture(fault: 'none' | 'body-reset' = 'none') {
  const restore = useEnv({
    PLATFORM_INSTANCE_ID: 'provision-timeout-fixture',
    PLATFORM_PROCESS_ROLE: undefined,
  });
  const ownerScheduling = {
    snapshot: () => schedulingOwner.snapshot(),
    pin: (id: string, owner: string) => schedulingOwner.pin(id, owner),
    originalOwnerId: (id: string) => schedulingOwner.originalOwnerId(id),
    assertCurrent: (observation: Awaited<ReturnType<RuntimeOwnerProviderRegistry['snapshot']>>) =>
      schedulingOwner.assertCurrent(observation),
  };
  const h = harness({ authority, ownerScheduling });
  h.sqlite
    .prepare(
      "INSERT INTO projects(id,name,source_type,clone_status,baseline_path,created_at,updated_at) VALUES('prj-1','fixture','empty','ready','/tmp/fixture-baseline',0,0)",
    )
    .run();
  const home = await mkdtemp(join(tmpdir(), 'provision-owner-timeout-'));
  h.workspace.prepare = async (id) => {
    h.wsCalls.push('prepare:' + id);
    const hostPath = join(home, 'workspaces', id);
    await mkdir(hostPath, { recursive: true });
    await writeFile(join(hostPath, 'original-workspace'), 'retained-before-native-start');
    return { hostPath, baselineExisted: true, entryCount: 1 };
  };
  h.workspace.cleanup = async (id, input) => {
    h.wsCalls.push(`cleanup:${id}:${input.keep}`);
    if (!input.keep) await rm(join(home, 'workspaces', id), { recursive: true, force: true });
    return input.keep ? { hostPath: join(home, 'workspaces', id) } : null;
  };
  let running = false;
  let stopped = false;
  const provider: SandboxProvider = h.provider;
  provider.inspect = async () => ({
    lifecycleState: running
      ? 'instance_running'
      : stopped
        ? 'instance_exited'
        : 'instance_creating',
  });
  const originalStart = h.provider.start.bind(h.provider);
  h.provider.start = async (handle) => {
    await originalStart(handle);
    running = true;
  };
  const external: ProviderRegistry = {
    defaultProvider: h.provider.name,
    get: () => h.provider,
    has: (name) => name === h.provider.name,
    list: () => [h.provider],
    register: () => {
      throw new Error('fixed external provider');
    },
  };
  const owner = new RuntimeOwnerServer({
    instanceId: 'provision-timeout-fixture',
    ownerId: 'original-owner',
    startIdentity: 'original-owner-start-identity',
    artifactIdentity: {
      artifactDigest: 'sha256:' + 'a'.repeat(64),
      inputFingerprint: 'sha256:' + 'b'.repeat(64),
    },
    capacity: async () => ({
      cores: 64,
      ramMb: 262144,
      diskTotalBytes: 4 * 1024 ** 4,
      diskAvailableBytes: 3 * 1024 ** 4,
    }),
    key,
    journalPath: join(home, 'owner.sqlite'),
    registry: external,
    clock: h.clock,
  });
  await owner.listen(0);
  const ownerOrigin = `http://127.0.0.1:${(owner.server.address() as AddressInfo).port}`;
  const proxy = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const body = Buffer.concat(chunks);
      const method = body.length
        ? (JSON.parse(body.toString()) as { method?: string }).method
        : undefined;
      const upstream = request(
        new URL(incoming.url ?? '/', ownerOrigin),
        { method: incoming.method, headers: incoming.headers, agent: false },
        (result) => {
          const resultChunks: Buffer[] = [];
          result.on('data', (chunk: Buffer) => resultChunks.push(chunk));
          result.on('end', () => {
            if (fault === 'body-reset' && method === 'start' && result.statusCode === 200) {
              response.writeHead(200, { 'content-type': 'application/json' });
              response.write('{"value":');
              response.flushHeaders();
              setTimeout(() => response.destroy(), 5);
            } else {
              response.writeHead(result.statusCode ?? 502, { 'content-type': 'application/json' });
              response.end(Buffer.concat(resultChunks));
            }
          });
          result.on('error', () => response.destroy());
        },
      );
      upstream.on('error', () => response.destroy());
      upstream.end(body);
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const remote = new RuntimeOwnerProviderRegistry();
  await remote.addOwner(
    {
      endpoint: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      key,
      instanceId: 'provision-timeout-fixture',
      generation: 1,
      clock: h.clock,
    },
    true,
  );
  const schedulingOwner = remote;
  h.registry.get = (name) => remote.get(name);
  const runs = vi.spyOn(h.provision, 'runSafely');
  const setRunning = () => {
    running = true;
  };
  const setStopped = () => {
    running = false;
    stopped = true;
  };
  return {
    h,
    owner,
    home,
    runs,
    setRunning,
    setStopped,
    close: async () => {
      remote.onModuleDestroy();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await owner.close();
      await rm(home, { recursive: true, force: true });
      restore();
      vi.restoreAllMocks();
    },
  };
}
function operations(owner: RuntimeOwnerServer) {
  return (
    owner.journal.continuity() as {
      operations: { id: string; method: string; state: string; sandboxId: string }[];
    }
  ).operations;
}
async function accepted(f: Awaited<ReturnType<typeof fixture>>, runtime = 'claude-code') {
  const dto = await f.h.service.create({
    projectId: 'prj-1',
    runtime,
    headless: true,
    timeoutMinutes: 30,
  });
  await expect.poll(() => f.runs.mock.results.length).toBe(1);
  const finished = f.runs.mock.results[0].value as Promise<void>;
  return { dto, finished };
}

/** Real selection, expiry checks, injection ledger and revocation on business
 * SQLite. Only credential materialization is controlled; no real secret exists. */
function runtimeCredential(f: Awaited<ReturnType<typeof fixture>>, expired: boolean) {
  const id = 'controlled-codex-credential';
  const now = f.h.clock.now().getTime();
  f.h.sqlite
    .prepare(
      "INSERT INTO credentials(id,kind,runtime_id,masked_identifier,encrypted_blob,iv,auth_tag,encryption_key_id,obtained_via,mode,issued_at,expires_at) VALUES(?,'runtime','codex','fixture','not-real-ciphertext','fixture','fixture','fixture','api-key','api-key',?,?)",
    )
    .run(
      id,
      Math.floor((now - 3600000) / 1000),
      Math.floor((now + (expired ? -1000 : 3600000)) / 1000),
    );
  let serial = 0;
  const service = new RuntimeCredentialService(
    new SqliteCredentialRepository(f.h.db),
    new SqliteCredentialSandboxBindingRepository(f.h.db),
    {
      encrypt: async () => {
        throw new Error('No real credential cryptography in fixture');
      },
      decrypt: async () => {
        throw new Error('No real credential cryptography in fixture');
      },
    },
    {
      materializeForInjection: async (input) => ({
        runtimeId: input.runtimeId,
        obtainedVia: input.obtainedVia,
        issuedAt: input.issuedAt.toISOString(),
        expiresAt: input.expiresAt?.toISOString(),
        credentialFiles: [],
        env: {},
        zeroize() {
          /* Controlled fixture contains no secret. */
        },
      }),
      materializeForRefresh: async () => {
        throw new Error('No OAuth refresh in fixture');
      },
    },
    f.h.uow,
    f.h.events,
    f.h.clock,
    { next: () => `controlled-binding-${++serial}` },
  );
  f.h.credentials.prepareRuntimeCredential = (runtimeId) =>
    service.prepareActive(runtimeId, 'api-key');
  f.h.credentials.isRuntimeCredentialUsable = (runtimeId, credentialId) =>
    service.isUsable(runtimeId, credentialId);
  f.h.credentials.recordRuntimeInjection = (runtimeId, sandboxId, credentialId) =>
    service.recordInjection(runtimeId, sandboxId, credentialId);
  const adapter = f.h.runtimes.get('codex');
  const inject = vi.spyOn(adapter, 'injectCredential').mockResolvedValue();
  return { id, service, adapter, inject };
}

function shortOwnerTimeout() {
  const timeout = ClientRequest.prototype.setTimeout;
  vi.spyOn(ClientRequest.prototype, 'setTimeout').mockImplementation(function (
    this: ClientRequest,
    ms: number,
    callback?: () => void,
  ) {
    return timeout.call(this, ms === 120000 ? 100 : ms, callback);
  });
}

function suspendStart(f: Awaited<ReturnType<typeof fixture>>) {
  const started = deferred<void>(),
    release = deferred<void>();
  f.h.provider.start = async () => {
    f.h.provider.calls.push('start');
    started.resolve();
    await release.promise;
    f.setRunning();
  };
  return { started, release };
}

async function completeOriginalStart(
  f: Awaited<ReturnType<typeof fixture>>,
  release: ReturnType<typeof deferred<void>>,
) {
  release.resolve();
  await expect
    .poll(() => operations(f.owner).find((operation) => operation.method === 'start')?.state)
    .toBe('complete');
}

describe('Owner start acknowledgement loss preserves the original provision [AC-UPG-007.3] [AC-CRD-003.6]', () => {
  it.each([true, false])(
    'recovers the same codex runtime after HTTP timeout with expired=%s credential, using real credential eligibility',
    async (expired) => {
      const f = await fixture(),
        credential = runtimeCredential(f, expired),
        { started, release } = suspendStart(f);
      shortOwnerTimeout();
      try {
        const prepare = vi.spyOn(f.h.credentials, 'prepareRuntimeCredential');
        const { dto, finished } = await accepted(f, 'codex');
        await started.promise;
        await finished;
        expect((await f.h.service.get(dto.id)).status).toBe('starting');
        const original = f.h.sqlite
          .prepare('SELECT provider_handle FROM sandboxes WHERE id=?')
          .get(dto.id);
        await completeOriginalStart(f, release);
        await f.h.provision.resumeUnconfirmed();
        expect((await f.h.service.get(dto.id)).status).toBe('running');
        expect(
          f.h.sqlite.prepare('SELECT provider_handle FROM sandboxes WHERE id=?').get(dto.id),
        ).toEqual(original);
        expect(prepare).toHaveBeenCalledTimes(2);
        expect(credential.inject).toHaveBeenCalledTimes(expired ? 0 : 1);
        expect(
          f.h.sqlite.prepare('SELECT injected_runtimes FROM sandboxes WHERE id=?').get(dto.id),
        ).toEqual({ injected_runtimes: JSON.stringify(expired ? [] : ['codex']) });
        const bindings = f.h.sqlite
          .prepare('SELECT credential_id FROM credential_sandbox_bindings WHERE sandbox_id=?')
          .all(dto.id);
        expect(bindings).toEqual(expired ? [] : [{ credential_id: credential.id }]);
        expect(f.h.provider.calls.filter((call) => call === 'create')).toHaveLength(1);
        expect(f.h.provider.calls.filter((call) => call === 'start')).toHaveLength(1);
        expect(f.h.provider.calls).not.toContain('destroy');
        expect(f.h.wsCalls.some((call) => call.startsWith('cleanup:'))).toBe(false);
        expect(
          await readFile(join(f.home, 'workspaces', dto.id, 'original-workspace'), 'utf8'),
        ).toBe('retained-before-native-start');
        expect((await f.h.allocations.listAll())[0].isActive).toBe(true);
        expect(
          f.h.sqlite
            .prepare('SELECT state FROM sandbox_create_intents WHERE sandbox_id=?')
            .get(dto.id),
        ).toEqual({ state: 'finished' });
      } finally {
        release.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await f.close();
      }
    },
  );

  it.each(['before-injection', 'during-injection'] as const)(
    'still rejects real SQLite revocation %s after recovery has reserved a valid credential',
    async (phase) => {
      const f = await fixture(),
        credential = runtimeCredential(f, false),
        { started, release } = suspendStart(f);
      shortOwnerTimeout();
      try {
        const { dto, finished } = await accepted(f, 'codex');
        await started.promise;
        await finished;
        await completeOriginalStart(f, release);
        let reserved = false;
        const reserve = f.h.credentials.recordRuntimeInjection.bind(f.h.credentials);
        f.h.credentials.recordRuntimeInjection = async (...args) => {
          const result = await reserve(...args);
          reserved ||= result;
          return result;
        };
        const revoke = async () => {
          expect(reserved).toBe(true);
          await credential.service.revoke('codex', credential.id);
        };
        if (phase === 'before-injection') credential.adapter.seedStartupFiles = revoke;
        else credential.inject.mockImplementation(revoke);
        await f.h.provision.resumeUnconfirmed();
        expect(await f.h.service.get(dto.id)).toMatchObject({
          status: 'failed',
          failureCode: 'AUTH_REJECTED',
          failureOperation: 'start',
        });
        expect(credential.inject).toHaveBeenCalledTimes(phase === 'before-injection' ? 0 : 1);
        expect(await credential.service.isUsable('codex', credential.id)).toBe(false);
        expect(
          f.h.sqlite
            .prepare(
              'SELECT revoked_at IS NOT NULL revoked, encrypted_blob FROM credentials WHERE id=?',
            )
            .get(credential.id),
        ).toEqual({ revoked: 1, encrypted_blob: null });
        expect(f.h.provider.calls.filter((call) => call === 'create')).toHaveLength(1);
        expect(f.h.provider.calls.filter((call) => call === 'start')).toHaveLength(1);
      } finally {
        release.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await f.close();
      }
    },
  );

  it('keeps the real workspace/handle/intent while start is pending, defers a second dispatch, then reconciles that same handle', async () => {
    const f = await fixture(),
      started = deferred<void>(),
      release = deferred<void>();
    const timeout = ClientRequest.prototype.setTimeout;
    vi.spyOn(ClientRequest.prototype, 'setTimeout').mockImplementation(function (
      this: ClientRequest,
      ms: number,
      callback?: () => void,
    ) {
      return timeout.call(this, ms === 120000 ? 100 : ms, callback);
    });
    f.h.provider.start = async () => {
      f.h.provider.calls.push('start');
      started.resolve();
      await release.promise;
      await readFile(join(f.home, 'workspaces', 'sbx-1', 'original-workspace'));
      f.setRunning();
    };
    try {
      const remoteStart = vi.spyOn(f.h.registry.get(f.h.provider.name), 'start');
      const { dto, finished } = await accepted(f);
      await started.promise;
      await finished; // The real ClientRequest timeout fired; the native effect is still pending.
      await expect(remoteStart.mock.results[0].value).rejects.toMatchObject({
        code: SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        retryable: true,
      });
      const before = f.h.sqlite
        .prepare('SELECT status,provider_handle,workspace_path FROM sandboxes WHERE id=?')
        .get(dto.id) as { status: string; provider_handle: string; workspace_path: string };
      expect(before.status).toBe('starting');
      expect(before.provider_handle).toBe('instance-' + dto.id);
      const timedOut = (await f.h.service.get(dto.id)).startupObservation;
      expect(timedOut).toMatchObject({ state: 'unknown', stage: 'instance-start' });
      expect(timedOut?.operationId).toMatch(/^sandbox-startup:/);
      // This is the original workflow cycle, deliberately not the Owner RPC id.
      expect(operations(f.owner).some((v) => v.id === timedOut?.operationId)).toBe(false);
      const restartedReader = new SqliteSandboxStartupProgress(f.h.db);
      expect(restartedReader.readSync(dto.id)).toMatchObject({
        operationId: timedOut?.operationId,
        sequence: timedOut?.sequence,
        startedAt: timedOut?.startedAt,
        stageEnteredAt: timedOut?.stageEnteredAt,
        lastProgressAt: timedOut?.lastProgressAt,
      });
      f.h.advanceClock(1000);
      const refreshed = (await f.h.service.get(dto.id)).startupObservation;
      expect(refreshed).toEqual({
        ...timedOut,
        observedAt: f.h.clock.now().toISOString(),
      });
      expect(await readFile(join(before.workspace_path, 'original-workspace'), 'utf8')).toBe(
        'retained-before-native-start',
      );
      expect(
        f.h.sqlite
          .prepare('SELECT state FROM sandbox_create_intents WHERE sandbox_id=?')
          .get(dto.id),
      ).toEqual({ state: 'bound' });
      expect((await f.h.allocations.listAll())[0].isActive).toBe(true);
      await f.h.provision.resumeUnconfirmed();
      const stillPending = (await f.h.service.get(dto.id)).startupObservation;
      expect(stillPending).toMatchObject({
        operationId: timedOut?.operationId,
        state: 'unknown',
        stage: 'instance-start',
        startedAt: timedOut?.startedAt,
        stageEnteredAt: timedOut?.stageEnteredAt,
        lastProgressAt: timedOut?.lastProgressAt,
        heartbeatAt: f.h.clock.now().toISOString(),
      });
      expect(assertDefined(stillPending).sequence).toBeGreaterThan(
        assertDefined(timedOut).sequence,
      );
      expect(f.h.provider.calls.filter((v) => v === 'create')).toHaveLength(1);
      expect(f.h.provider.calls.filter((v) => v === 'start')).toHaveLength(1);
      expect(f.h.provider.calls).not.toContain('destroy');
      expect(f.h.wsCalls.some((v) => v.startsWith('cleanup:'))).toBe(false);
      expect(operations(f.owner).filter((v) => v.method === 'start')).toHaveLength(1);
      release.resolve();
      await expect
        .poll(() => operations(f.owner).find((v) => v.method === 'start')?.state)
        .toBe('complete');
      await f.h.provision.resumeUnconfirmed();
      await f.h.provision.resumeUnconfirmed();
      expect((await f.h.service.get(dto.id)).status).toBe('running');
      expect((await f.h.service.get(dto.id)).startupObservation).toMatchObject({
        operationId: timedOut?.operationId,
        state: 'succeeded',
        stage: 'completed',
        startedAt: timedOut?.startedAt,
        lastProgressAt: f.h.clock.now().toISOString(),
      });
      const stages = f.h.instanceProgressEvents.flatMap((event) =>
        event.event === 'sandbox.instance_progress' && event.startupObservation
          ? [event.startupObservation.stage]
          : [],
      );
      expect(stages).toContain('runtime-tools');
      expect(stages).toContain('environment-initialization');
      expect(stages).toContain('agent-bootstrap');
      expect(stages).not.toContain('image-pull');
      expect(
        f.h.sqlite.prepare('SELECT provider_handle FROM sandboxes WHERE id=?').get(dto.id),
      ).toEqual({ provider_handle: before.provider_handle });
      expect(
        f.h.sqlite
          .prepare('SELECT state FROM sandbox_create_intents WHERE sandbox_id=?')
          .get(dto.id),
      ).toEqual({ state: 'finished' });
      expect(f.h.provider.calls.filter((v) => v === 'start')).toHaveLength(1);
      expect(f.h.provider.calls).not.toContain('destroy');
      expect((await f.h.allocations.listAll())[0].isActive).toBe(true);
    } finally {
      release.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await f.close();
    }
  });
  it('treats a response-body reset after the owner completed start as unconfirmed, then recovers without repeating start', async () => {
    const f = await fixture('body-reset');
    try {
      const remoteStart = vi.spyOn(f.h.registry.get(f.h.provider.name), 'start');
      const { dto, finished } = await accepted(f);
      await finished;
      await expect(remoteStart.mock.results[0].value).rejects.toMatchObject({
        code: SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        retryable: true,
      });
      expect((await f.h.service.get(dto.id)).status).toBe('starting');
      expect(f.h.provider.calls).not.toContain('destroy');
      await f.h.provision.resumeUnconfirmed();
      expect((await f.h.service.get(dto.id)).status).toBe('running');
      expect(f.h.provider.calls.filter((v) => v === 'start')).toHaveLength(1);
      expect(f.h.provider.calls.filter((v) => v === 'create')).toHaveLength(1);
      expect(f.h.wsCalls.some((v) => v.startsWith('cleanup:'))).toBe(false);
    } finally {
      await f.close();
    }
  });
  it('preserves a definite Owner image failure and still performs the original failure compensation', async () => {
    const f = await fixture();
    f.h.provider.start = async () => {
      f.h.provider.calls.push('start');
      throw new SandboxProviderError(
        SandboxProviderErrorCode.IMAGE_PULL_FAILED,
        'definite image failure',
        undefined,
        false,
      );
    };
    try {
      const { dto, finished } = await accepted(f);
      await finished;
      const actual = await f.h.service.get(dto.id);
      expect(actual.status).toBe('failed');
      expect(actual.failureCode).toBe('IMAGE_PULL_FAILED');
      expect(actual.startupObservation).toMatchObject({
        state: 'failed',
        stage: 'instance-start',
      });
      expect(f.h.provider.calls.filter((v) => v === 'destroy')).toHaveLength(1);
      expect(f.h.wsCalls).toContain('cleanup:' + dto.id + ':false');
      expect((await f.h.allocations.listAll())[0].isActive).toBe(false);
    } finally {
      await f.close();
    }
  });
  it('keeps a timed-out original stop and quota, then reconciles its journal receipt without another stop', async () => {
    const f = await fixture();
    const started = deferred<void>(),
      release = deferred<void>();
    f.h.provider.stop = async () => {
      f.h.provider.calls.push('stop');
      started.resolve();
      await release.promise;
      f.setStopped();
    };
    try {
      const { dto, finished } = await accepted(f);
      await finished;
      const original = f.h.sqlite
        .prepare('SELECT provider_handle,workspace_path FROM sandboxes WHERE id=?')
        .get(dto.id);
      shortOwnerTimeout();
      const stop = f.h.service.stop(dto.id).catch((error: unknown) => error);
      await started.promise;
      const error = await stop;
      expect(error).toMatchObject({ status: 503 });
      expect((await f.h.service.get(dto.id)).status).toBe('stopping');
      expect((await f.h.allocations.listAll())[0].isActive).toBe(true);
      const originalOperation = operations(f.owner).find((v) => v.method === 'stop');
      expect(originalOperation).toMatchObject({ state: 'pending', sandboxId: dto.id });
      expect(assertDefined(originalOperation).id).toMatch(/^stop:sandbox-stop-/);
      await f.h.provision.resumeUnconfirmed();
      await f.h.provision.resumeUnconfirmed();
      expect((await f.h.service.get(dto.id)).status).toBe('stopping');
      expect(f.h.provider.calls.filter((v) => v === 'stop')).toHaveLength(1);
      release.resolve();
      await expect
        .poll(
          () =>
            operations(f.owner).find((v) => v.id === assertDefined(originalOperation).id)?.state,
        )
        .toBe('complete');
      await f.h.provision.resumeUnconfirmed();
      await f.h.provision.resumeUnconfirmed();
      expect((await f.h.service.get(dto.id)).status).toBe('stopped');
      expect(
        f.h.sqlite
          .prepare('SELECT provider_handle,workspace_path FROM sandboxes WHERE id=?')
          .get(dto.id),
      ).toEqual(original);
      expect((await f.h.allocations.listAll())[0].isActive).toBe(true);
      expect(f.h.provider.calls.filter((v) => v === 'stop')).toHaveLength(1);
      expect(f.h.provider.calls).not.toContain('destroy');
      expect(
        f.h.sqlite.prepare("SELECT state FROM platform_operations WHERE role='sandbox-stop'").all(),
      ).toEqual([{ state: 'finished' }]);
    } finally {
      release.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await f.close();
    }
  });
});
