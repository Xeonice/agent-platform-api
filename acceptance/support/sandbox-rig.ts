import { afterEach } from 'vitest';
import type { Clock, DomainEvent, EventBus } from '@platform/shared-kernel';
import { CredentialPreparationError } from '@platform/contracts';
import type {
  BootstrapAgentSessionInput,
  CredentialFacade,
  EnsureRuntimeInstalledInput,
  ImageFacade,
  InjectableRuntimeCredential,
  ProjectFacade,
  ProviderRegistry,
  RegisterRetainedVolumeCommand,
  RuntimeAdapterRegistry,
  SandboxProvider,
  TaskLogStore,
  WaitingInputQueryPort,
  WorkspacePreparer,
} from '@platform/contracts';
import { DefaultRuntimeAdapterRegistry } from '../../packages/modules/runtime/src/infrastructure/registry/runtime-adapter.registry';
import { CodexAdapter } from '../../packages/modules/runtime/src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../packages/modules/runtime/src/infrastructure/adapters/claude-code/claude-code.adapter';
import { SandboxApplicationService } from '../../packages/modules/sandbox/src/application/sandbox-application.service';
import { ResourceAllocator } from '../../packages/modules/sandbox/src/application/resource-allocator';
import { SchedulerQueue } from '../../packages/modules/sandbox/src/application/scheduler-queue';
import { SandboxExecAdapter } from '../../packages/modules/sandbox/src/application/sandbox-exec.adapter';
import { SandboxHealthMonitor } from '../../packages/modules/sandbox/src/application/sandbox-health.monitor';
import { AgentTaskApplicationService } from '../../packages/modules/sandbox/src/application/agent-task.service';
import { ProvisionSandboxWorkflow } from '../../packages/modules/sandbox/src/application/workflows/provision-sandbox.workflow';
import { RunAgentTaskWorkflow } from '../../packages/modules/sandbox/src/application/workflows/run-agent-task.workflow';
import { SqliteSandboxRepository } from '../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/sandbox.repository.impl';
import { SqliteResourceAllocationRepository } from '../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/resource-allocation.repository.impl';
import { SqliteAgentTaskRepository } from '../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/agent-task.repository.impl';
import type { HostCapacity } from '../../packages/modules/sandbox/src/domain/services/resource-pool.domain-service';
import { currentDatabase, seedImageManifest } from './sqlite';

import { ScriptedProvider } from './external-provider';
export { ScriptedProvider } from './external-provider';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Fresh assembly: actual production services, repositories, schema and UoW. */
export function harness(
  options: {
    credential?: InjectableRuntimeCredential;
    hostCapacity?: Partial<HostCapacity>;
    waiting?: WaitingInputQueryPort;
  } = {},
) {
  const { sqlite, db, uow } = currentDatabase();
  const repo = new SqliteSandboxRepository(db);
  const allocations = new SqliteResourceAllocationRepository(db);
  const taskRepo = new SqliteAgentTaskRepository(db);
  let time = Date.parse('2026-10-05T00:00:00Z');
  const clock: Clock = { now: () => new Date(time) };
  let serial = 0;
  const ids = { next: () => `sbx-${++serial}` };
  const publishedEvents: DomainEvent[] = [];
  const events: EventBus = {
    publishInTx: (_tx, batch) => {
      publishedEvents.push(...batch);
    },
    subscribe: () => {},
  };
  const calls: string[] = [];
  const provider = new ScriptedProvider();
  const providers = new Map<string, SandboxProvider>([[provider.name, provider]]);
  const registry: ProviderRegistry = {
    defaultProvider: provider.name,
    register: (value) => {
      if (providers.has(value.name)) throw new Error('duplicate provider');
      providers.set(value.name, value);
    },
    get: (name) => {
      const found = providers.get(name);
      if (!found) throw new Error('unknown provider');
      return found;
    },
    has: (name) => providers.has(name),
    list: () => [...providers.values()],
  };
  const adapter = new ClaudeCodeAdapter();
  adapter.injectCredential = async () => {
    calls.push('injectCredential');
  };
  const runtimes: RuntimeAdapterRegistry = new DefaultRuntimeAdapterRegistry(
    new CodexAdapter(),
    adapter,
  );
  const wsCalls: string[] = [];
  const workspace: WorkspacePreparer = {
    prepare: async (id) => {
      wsCalls.push(`prepare:${id}`);
      return { hostPath: `/tmp/acceptance/${id}`, baselineExisted: true, entryCount: 0 };
    },
    cleanup: async (id, input) => {
      wsCalls.push(`cleanup:${id}:${input.keep}`);
      return input.keep ? { hostPath: `/tmp/acceptance/${id}` } : null;
    },
  };
  const retainedRegistrations: RegisterRetainedVolumeCommand[] = [];
  const projectFacade: ProjectFacade = {
    getRuntimeContextForTask: async (projectId, branch) => ({
      projectId,
      baselinePath: `/tmp/baseline/${projectId}`,
      sourceType: 'empty',
      baselineSizeBytes: null,
      branch,
    }),
    assertCanCreateTaskSync: () => {},
    registerRetainedVolume: async (command) => {
      retainedRegistrations.push(command);
    },
  };
  const revokedCredentials = new Set<string>();
  const injections: string[] = [];
  const credentials: CredentialFacade = {
    prepareRuntimeCredential: async (runtimeId) => {
      if (!options.credential)
        throw new CredentialPreparationError(
          'NO_CREDENTIAL',
          'synthetic fixture has no credential',
        );
      return { ...options.credential, credentialId: `cred-${runtimeId}` };
    },
    isRuntimeCredentialUsable: async (_runtimeId, id) => !revokedCredentials.has(id),
    recordRuntimeInjection: async (runtimeId, sandboxId, id) => {
      if (revokedCredentials.has(id)) return false;
      injections.push(`${runtimeId}:${sandboxId}`);
      return true;
    },
    prepareForRefresh: async () => {
      throw new Error('refresh outside scenario');
    },
    prepareGitAuth: async () => {
      throw new Error('git outside scenario');
    },
  };
  const selections = new Map<string, Awaited<ReturnType<ImageFacade['resolveForTask']>>>();
  const imageFacade: ImageFacade = {
    resolveForTask: async (selector) => {
      const ref = selector || 'registry.test/default:latest';
      const manifestId = `manifest-${ref}`;
      seedImageManifest(sqlite, { manifestId, name: ref });
      const image = {
        manifestId,
        ref,
        digest: `sha256:${'a'.repeat(64)}`,
        resolvedAt: clock.now().toISOString(),
        manifest: {
          name: ref,
          version: 'latest',
          baseImage: ref,
          entrypointContract: { workdir: '/', entrypoint: ['/bin/sh'] },
          supportedRuntimes: ['claude-code'],
          resourceDefaults: { cores: 1, ramMb: 512, diskMb: 512 },
          labelsRequired: ['platform.tmux'],
          diffIds: [`sha256:${'b'.repeat(64)}`],
        },
      };
      selections.set(manifestId, image);
      return image;
    },
    findTaskImage: async (id) => selections.get(id) ?? null,
    findTaskImageSummary: async (id) => {
      const selected = selections.get(id);
      return selected
        ? {
            manifestId: id,
            ref: selected.ref,
            digest: selected.digest,
            isBuiltin: false,
            isActive: true,
            validationStatus: 'valid' as const,
          }
        : null;
    },
    findRegisteredByRef: async (ref) => {
      const selected = [...selections.values()].find((image) => image.ref === ref);
      return selected
        ? {
            manifestId: selected.manifestId,
            ref,
            digest: selected.digest,
            isBuiltin: false,
            isActive: true,
            validationStatus: 'valid' as const,
          }
        : null;
    },
  };
  const hostCapacity: HostCapacity = {
    cores: 64,
    ramMb: 262144,
    diskTotalBytes: 4 * 1024 ** 4,
    diskAvailableBytes: 2 * 1024 ** 4,
    ...options.hostCapacity,
  };
  const audit = { record: () => {} };
  const schedulerQueue = new SchedulerQueue(clock, audit);
  let allocationSerial = 0;
  const resources = new ResourceAllocator(
    allocations,
    { capacity: async () => ({ ...hostCapacity }) },
    uow,
    clock,
    { next: () => `allocation-${++allocationSerial}` },
    schedulerQueue,
  );
  const installInputs: EnsureRuntimeInstalledInput[] = [];
  const bootstrapInputs: BootstrapAgentSessionInput[] = [];
  const provision = new ProvisionSandboxWorkflow(
    repo,
    uow,
    events,
    clock,
    workspace,
    runtimes,
    {
      ensureInstalled: async (input) => {
        installInputs.push(input);
      },
    },
    credentials,
    {
      bootstrapAgentSession: async (input) => {
        bootstrapInputs.push(input);
        return { promptConsumed: Boolean(input.initialPrompt?.trim()), reusedExisting: false };
      },
    },
    imageFacade,
    audit,
    { broadcast: () => {} },
    resources,
  );
  const healthMonitor = new SandboxHealthMonitor(repo, registry, clock, audit);
  const waiting = options.waiting ?? {
    isWaiting: () => false,
    filterWaiting: () => new Set<string>(),
  };
  const service = new SandboxApplicationService(
    repo,
    uow,
    events,
    clock,
    ids,
    registry,
    workspace,
    projectFacade,
    imageFacade,
    runtimes,
    provision,
    healthMonitor,
    resources,
    waiting,
  );
  const logBytes = new Map<string, string>();
  const taskLogs: TaskLogStore = {
    prepare: async (id) => `/tmp/acceptance-logs/${id}`,
    appendStdout: async (id, text) => {
      logBytes.set(id, (logBytes.get(id) ?? '') + text);
    },
    appendStderr: async () => {},
    truncateStdout: async (id, bytes) => {
      logBytes.set(
        id,
        Buffer.from(logBytes.get(id) ?? '')
          .subarray(0, bytes)
          .toString(),
      );
    },
    streamStdoutLines: async function* (id) {
      for (const line of (logBytes.get(id) ?? '').split('\n')) if (line) yield line;
    },
    flush: async () => {},
  };
  const taskWorkflow = new RunAgentTaskWorkflow(
    taskRepo,
    repo,
    uow,
    events,
    clock,
    ids,
    registry,
    runtimes,
    taskLogs,
    { publish: () => {} },
  );
  const taskService = new AgentTaskApplicationService(
    taskRepo,
    repo,
    registry,
    runtimes,
    taskWorkflow,
  );
  cleanups.push(() => {
    taskWorkflow.shutdown();
    sqlite.close();
  });
  return {
    sqlite,
    db,
    service,
    repo,
    allocations,
    uow,
    events,
    clock,
    resources,
    schedulerQueue,
    taskRepo,
    taskLogs,
    taskWorkflow,
    taskService,
    provider,
    registry,
    runtimes,
    adapter,
    waiting,
    workspace,
    projectFacade,
    credentials,
    revokedCredentials,
    injections,
    calls,
    wsCalls,
    retainedRegistrations,
    publishedEvents,
    imageFacade,
    installInputs,
    bootstrapInputs,
    hostCapacity,
    execPort: new SandboxExecAdapter(repo, registry),
    stopPumps: () => taskWorkflow.shutdown(),
    advanceClock: (ms: number) => {
      time += ms;
    },
  };
}

export async function waitForStatus(
  service: SandboxApplicationService,
  id: string,
  status: string,
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = await service.get(id);
    if (current.status === status) return current;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`task ${id} did not reach ${status}`);
}
