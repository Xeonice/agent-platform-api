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
import {
  explicitRuntimeBusinessAuthority,
  withRuntimeBusinessAuthority,
} from '../../../packages/modules/sandbox/src/infrastructure/runtime-rpc/authority-context';
import { harness } from '../../support/sandbox-rig';
import { deferred, useEnv } from '../../support/strict-ports';

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
  const h = harness({ authority });
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
  const provider: SandboxProvider = h.provider;
  provider.inspect = async () => ({
    lifecycleState: running ? 'instance_running' : 'instance_creating',
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
  h.registry.get = (name) => remote.get(name);
  const runs = vi.spyOn(h.provision, 'runSafely');
  const setRunning = () => {
    running = true;
  };
  return {
    h,
    owner,
    home,
    runs,
    setRunning,
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
async function accepted(f: Awaited<ReturnType<typeof fixture>>) {
  const dto = await f.h.service.create({
    projectId: 'prj-1',
    runtime: 'claude-code',
    headless: true,
    timeoutMinutes: 30,
  });
  await expect.poll(() => f.runs.mock.results.length).toBe(1);
  const finished = f.runs.mock.results[0].value as Promise<void>;
  return { dto, finished };
}

describe('Owner start acknowledgement loss preserves the original provision [AC-UPG-007.3]', () => {
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
      expect(f.h.provider.calls.filter((v) => v === 'destroy')).toHaveLength(1);
      expect(f.h.wsCalls).toContain('cleanup:' + dto.id + ':false');
      expect((await f.h.allocations.listAll())[0].isActive).toBe(false);
    } finally {
      await f.close();
    }
  });
});
