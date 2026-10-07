import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asProjectId, asSandboxId } from '@platform/shared-kernel';
import { BoxliteSandboxProvider } from '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-sandbox.provider';
import { QuotaReconciler } from '../../../packages/modules/sandbox/src/application/quota-reconciler';
import { Sandbox } from '../../../packages/modules/sandbox/src/domain/entities/sandbox.entity';
import { SqliteSandboxRepository } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/sandbox.repository.impl';
import { SqliteResourceAllocationRepository } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/resource-allocation.repository.impl';
import { harness } from '../../support/sandbox-rig';

// Model the SDK boundary: metrics on a fresh stopped handle starts its VM implicitly.
// The real provider and reconciliation services must never enter that boundary while inspecting it.
const native = vi.hoisted(() => ({
  status: 'stopped',
  running: false,
  metadataReads: 0,
  handleReads: 0,
  metricReads: 0,
  implicitStarts: 0,
  stops: 0,
  failMetrics: false,
  missing: false,
  stopBeforeHandle: false,
}));
vi.mock(
  '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-runtime',
  () => ({
    getSharedBoxliteRuntime: async () => ({
      getInfo: async () => {
        native.metadataReads++;
        if (native.missing) return null;
        return {
          state: { status: native.status, running: native.running },
          healthStatus: { state: 'Healthy', failures: 0, lastCheck: '2026-10-05T00:00:00Z' },
        };
      },
      get: async () => {
        native.handleReads++;
        if (native.stopBeforeHandle) {
          native.status = 'stopped';
          native.running = false;
        }
        return {
          info: () => ({ state: { status: native.status, running: native.running } }),
          stop: async () => {
            native.stops++;
            native.status = 'stopped';
            native.running = false;
          },
          metrics: async () => {
            native.metricReads++;
            if (native.failMetrics) throw new Error('synthetic metrics unavailable');
            if (!native.running) {
              native.implicitStarts++;
              native.status = 'running';
              native.running = true;
            }
            return { execErrorsTotal: 7 };
          },
        };
      },
    }),
  }),
);

beforeEach(() => {
  Object.assign(native, {
    status: 'stopped',
    running: false,
    metadataReads: 0,
    handleReads: 0,
    metricReads: 0,
    implicitStarts: 0,
    stops: 0,
    failMetrics: false,
    missing: false,
    stopBeforeHandle: false,
  });
});
afterEach(() => vi.restoreAllMocks());

const handle = { provider: 'boxlite', providerSandboxId: 'preserved-box' };

describe('BoxLite inspection preserves stopped VMs and their retained task slots', () => {
  it.each(['stopped', 'paused', 'dead'])(
    'reads %s metadata without acquiring a live handle',
    async (status) => {
      native.status = status;
      const provider = new BoxliteSandboxProvider();
      const result = await provider.inspect(handle);
      expect(result.lifecycleState).toBe(
        status === 'stopped'
          ? 'instance_exited'
          : status === 'paused'
            ? 'instance_paused'
            : 'instance_dead',
      );
      expect(result.raw).not.toHaveProperty('execErrorsTotal');
      expect(native).toMatchObject({
        status,
        running: false,
        metadataReads: 1,
        handleReads: 0,
        metricReads: 0,
        implicitStarts: 0,
      });
    },
  );

  it.each(['configured', 'stopping', 'unknown'])(
    'does not acquire live state for nonrunning %s metadata',
    async (status) => {
      native.status = status;
      await new BoxliteSandboxProvider().inspect(handle);
      expect(native).toMatchObject({
        status,
        running: false,
        handleReads: 0,
        metricReads: 0,
        implicitStarts: 0,
      });
    },
  );

  it('reports a missing instance without acquiring a live handle', async () => {
    native.missing = true;
    expect(await new BoxliteSandboxProvider().inspect(handle)).toEqual({
      lifecycleState: 'instance_missing',
    });
    expect(native).toMatchObject({
      metadataReads: 1,
      handleReads: 0,
      metricReads: 0,
      implicitStarts: 0,
    });
  });

  it('keeps live health and cumulative execution metrics for running VMs', async () => {
    native.status = 'running';
    native.running = true;
    const result = await new BoxliteSandboxProvider().inspect(handle);
    expect(result).toMatchObject({
      lifecycleState: 'instance_running',
      health: { state: 'healthy', consecutiveFailures: 0 },
      raw: { execErrorsTotal: 7 },
    });
    expect(native).toMatchObject({ metricReads: 1, implicitStarts: 0, running: true });
  });

  it('keeps a running VM visible when its optional metrics are unavailable', async () => {
    native.status = 'running';
    native.running = true;
    native.failMetrics = true;
    const result = await new BoxliteSandboxProvider().inspect(handle);
    expect(result.lifecycleState).toBe('instance_running');
    expect(result.raw).not.toHaveProperty('execErrorsTotal');
    expect(native.metricReads).toBe(1);
  });

  it('does not restart a VM stopped between metadata sampling and acquiring its handle', async () => {
    native.status = 'running';
    native.running = true;
    native.stopBeforeHandle = true;
    const result = await new BoxliteSandboxProvider().inspect(handle);
    expect(result.raw).not.toHaveProperty('execErrorsTotal');
    expect(native).toMatchObject({
      status: 'stopped',
      running: false,
      handleReads: 1,
      metricReads: 0,
      implicitStarts: 0,
    });
  });

  it('stop then startup quota reconciliation preserves SQLite identity, registration and workspace without restarting the VM', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'stopped-boxlite-'));
    const file = join(directory, 'report.md');
    writeFileSync(file, 'preserved task output', { mode: 0o600 });
    const h = harness();
    const provider = new BoxliteSandboxProvider(h.clock);
    h.registry.register(provider);
    native.status = 'running';
    native.running = true;
    const sandbox = Sandbox.create({
      id: asSandboxId('preserved-task'),
      projectId: asProjectId('prj-1'),
      runtime: 'claude-code',
      provider: provider.name,
      imageRef: '',
      headless: false,
      timeoutMinutes: null,
      idleTimeoutSec: 1800,
      now: h.clock.now(),
    });
    for (const status of [
      'scheduling',
      'preparing-workspace',
      'creating',
      'starting',
      'running',
    ] as const)
      sandbox.transitionTo(status, 'scheduler', h.clock.now());
    sandbox.bindRuntime({ providerSandboxId: handle.providerSandboxId, workspacePath: directory });
    await h.resources.reserve(
      { sandboxId: sandbox.id, quota: { cores: 2, ramMb: 2048, diskMb: 512 } },
      (tx) => h.repo.saveSync(tx, sandbox),
    );
    const before = await h.allocations.findActiveBySandbox(sandbox.id);
    let reconciler: QuotaReconciler | undefined;
    try {
      expect(await h.service.stop(sandbox.id)).toMatchObject({ id: sandbox.id, status: 'stopped' });
      expect(native).toMatchObject({ running: false, status: 'stopped', stops: 1 });
      // A fresh repository/provider/reconciler assembly reads the persisted rows on startup.
      const repo = new SqliteSandboxRepository(h.db);
      const allocations = new SqliteResourceAllocationRepository(h.db);
      const recoveredProvider = new BoxliteSandboxProvider(h.clock);
      reconciler = new QuotaReconciler(
        allocations,
        repo,
        {
          ...h.registry,
          get: (name) => (name === 'boxlite' ? recoveredProvider : h.registry.get(name)),
        },
        h.events,
        h.clock,
        h.resources,
      );
      await reconciler.onApplicationBootstrap();
      const recovered = await repo.findById(sandbox.id);
      expect(recovered).toMatchObject({
        id: sandbox.id,
        status: 'stopped',
        providerSandboxId: handle.providerSandboxId,
        workspacePath: directory,
      });
      const allocation = await allocations.findActiveBySandbox(sandbox.id);
      expect(allocation).toMatchObject({
        id: before?.id,
        sandboxId: sandbox.id,
        releasedAt: null,
        reconciliationStatus: 'confirmed',
        quota: { cores: 2, ramMb: 2048, diskMb: 512 },
      });
      expect(readFileSync(file, 'utf8')).toBe('preserved task output');
      expect(native).toMatchObject({
        status: 'stopped',
        running: false,
        stops: 1,
        metricReads: 0,
        implicitStarts: 0,
      });
      expect(h.publishedEvents.some((event) => event.type === 'SandboxReconciledAsOrphan')).toBe(
        false,
      );
    } finally {
      reconciler?.onModuleDestroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
