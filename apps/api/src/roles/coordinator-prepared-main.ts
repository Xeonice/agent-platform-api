import { RetirementWorkTracker } from '../platform/upgrade/retirement-census';
import { HttpException, type INestApplication } from '@nestjs/common';
import { upgradeRecord, requiredUpgradeValue } from '../platform/upgrade/upgrade-values';
import type { HandoffRow } from '../platform/upgrade/coordinator-handoff';
import 'reflect-metadata';
import { createServer, Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { SANDBOX_PROVIDER_REGISTRY } from '@platform/contracts';
import type { RuntimeOwnerProviderRegistry } from '@platform/sandbox';
import { AgentTaskApplicationService, QuotaReconciler } from '@platform/sandbox';
import { ImageSeeder } from '@platform/image';
import { PROJECT_READ_PROJECTION, type ProjectReadProjection } from '@platform/project';
import { supportedDataFormats } from '../platform/data-format-capabilities';
import { SystemClock } from '../platform/time/system-clock';
import { env } from '../platform/config/env';
import { PlatformLoggerService } from '../platform/logging';
import {
  activatePreparedPlatform,
  platformConnection,
} from '../platform/persistence/platform.module';
import { configurePlatformApp } from '../bootstrap/configure-app';
import { setupWebsockets } from '../bootstrap/websocket.setup';
import {
  readPublicNetworkConfig,
  type PublicNetworkConfig,
} from '../platform/config/public-network';
import { UpgradeStore } from '../platform/upgrade/upgrade-store';
import { CoordinatorHandoffBudget } from '../platform/upgrade/coordinator-handoff-budget';
import { completePreparedCoordinatorAdoption } from '../platform/upgrade/prepared-coordinator-adoption';
import { requireUpgrade, UpgradeError } from '../platform/upgrade/upgrade-trust';
import { coordinatorArtifactIdentity } from '../platform/upgrade/coordinator-artifact-identity';
import { CoordinatorWorkRegistry, installCoordinatorWorkRegistry } from '@platform/shared-kernel';
import { coordinatorWriterControl } from '../platform/persistence/coordinator-lease';
import {
  assertCurrentBusinessAction,
  withoutBusinessAction,
} from '../platform/upgrade/upgrade-business-action';

export function preparedCoordinatorBusinessTransportReady(app: INestApplication): boolean {
  const server: unknown = app.getHttpServer();
  return server instanceof Server && server.listening;
}

/** Match the normal Coordinator's logger before publishing prepared identity.
 * Explicitly flush its startup buffer while the source writer is still live;
 * adoption never has to flush the accumulated startup backlog in its budget. */
export function attachPreparedCoordinatorLogger(app: INestApplication): void {
  app.useLogger(app.get(PlatformLoggerService));
  app.flushLogs();
}

/** Reserve the actual business socket and assemble its transport before the
 * old writer quiesces. Nest init hooks are deliberately NOT run here: they may
 * reconcile/write state or start workers. The gate remains closed until the
 * caller has acquired the writer, initialized hooks and published continuity. */
export async function prepareCoordinatorHttpTransport(
  app: INestApplication,
  network: PublicNetworkConfig,
  address: { host: string; port: number },
  ready: () => boolean,
): Promise<() => Promise<void>> {
  app.use((_req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (ready()) {
      next();
      return;
    }
    res.statusCode = 425;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        code: 'APPLICATION_WRITER_QUIESCED',
        sideEffectFree: true,
        retryable: true,
      }),
    );
  });
  configurePlatformApp(app, network);
  setupWebsockets(app, network, ready);
  const server: unknown = app.getHttpServer();
  requireUpgrade(server instanceof Server, 'PREPARED_HTTP_SERVER_REQUIRED');
  await new Promise<void>((ok, fail) => {
    const failed = (error: Error) => {
      server.off('listening', listening);
      fail(error);
    };
    const listening = () => {
      server.off('error', failed);
      ok();
    };
    server.once('error', failed);
    server.once('listening', listening);
    server.listen(address.port, address.host);
  });
  return async () => {
    await app.init();
  };
}

/** Preconstruct real B providers with read-only DB; no module/startup hook runs. */
export async function startPreparedCoordinator(): Promise<void> {
  const clock = new SystemClock();
  process.env.PLATFORM_PROCESS_ROLE = 'coordinator-prepared';
  // Role handoff preserves existing Guests; never inherit legacy orphan cleanup.
  process.env.SANDBOX_RECONCILE_ON_BOOT = 'false';
  const workers = new CoordinatorWorkRegistry();
  installCoordinatorWorkRegistry(workers);
  const managementWorker = workers.register('platform.prepared-management');
  process.env.COORDINATOR_WRITER_FENCE_VALID = 'false';
  const instanceId = process.env.PLATFORM_INSTANCE_ID,
    key = process.env.PLATFORM_CONTROLLER_RPC_KEY;
  requireUpgrade(
    instanceId &&
      key &&
      key.length >= 32 &&
      process.env.PLATFORM_COORDINATOR_BINDING_PATH &&
      ['127.0.0.1', '::1', 'localhost'].includes(env.host),
    'PREPARED_COORDINATOR_CONFIG_REQUIRED',
  );
  const physical = await coordinatorArtifactIdentity();
  const [{ AppModule }, { installNormalCoordinatorRetirement }, { sealCoordinatorWorkerManifest }] =
    await Promise.all([
      import('../app.module'),
      import('../platform/upgrade/normal-coordinator-retirement'),
      import('../platform/upgrade/coordinator-worker-manifest'),
    ]);
  platformConnection();
  const app = await NestFactory.create(AppModule, { bufferLogs: true, abortOnError: false });
  attachPreparedCoordinatorLogger(app);
  const quota = app.get(QuotaReconciler);
  const taskRecovery = app.get(AgentTaskApplicationService);
  quota.deferStartupUntilReady();
  taskRecovery.deferStartupUntilReady();
  // Resolve and validate future builtin metadata before exposing prepared identity;
  // app.listen during adoption consumes only these process-local prepared results.
  await app.get(ImageSeeder).prepare();
  const store = app.get(UpgradeStore),
    owners = app.get<RuntimeOwnerProviderRegistry>(SANDBOX_PROVIDER_REGISTRY);
  let projection: ProjectReadProjection | undefined;
  try {
    projection = app.get<ProjectReadProjection>(PROJECT_READ_PROJECTION, { strict: false });
  } catch {
    projection = undefined;
  }
  let state: 'prepared' | 'adopting' | 'ready' | 'unknown' = 'prepared';
  let businessReady = false;
  let adopting: Promise<Record<string, unknown>> | null = null;
  let adoptedIntent: string | null = null;
  let moduleInitializationStarted = false;
  const initializeBusinessTransport = await prepareCoordinatorHttpTransport(
    app,
    readPublicNetworkConfig(),
    { host: env.host, port: env.port },
    () => businessReady,
  );
  app.enableShutdownHooks();
  let recoveryWatch: NodeJS.Timeout | undefined = undefined;
  const retirement = new RetirementWorkTracker();
  const normalRetirement = installNormalCoordinatorRetirement(app, workers, {
    managementWork: () => retirement.snapshot().work,
    managementHttp: () => retirement.snapshot().http,
    writer: () => {
      if (!moduleInitializationStarted && !adopting && store.sqlite.readonly) return false;
      try {
        coordinatorWriterControl(store.sqlite).assert();
        return true;
      } catch (error) {
        return error instanceof UpgradeError && error.code === 'COORDINATOR_WRITER_FENCE_EXPIRED'
          ? false
          : null;
      }
    },
  });
  const identity = () => ({
    role: state === 'ready' ? 'coordinator' : 'coordinator-prepared',
    instanceId,
    pid: process.pid,
    startIdentity: process.env.PLATFORM_PROCESS_START_IDENTITY ?? null,
    artifactDigest: physical?.artifactDigest ?? null,
    inputFingerprint: physical?.inputFingerprint ?? null,
    supportedDataFormats: supportedDataFormats(projection),
    prepared: state === 'prepared',
    writerFenceValid: process.env.COORDINATOR_WRITER_FENCE_VALID === 'true',
    workersStarted: state === 'ready',
    businessTransportPrepared: preparedCoordinatorBusinessTransportReady(app),
    state,
    generation: Number(process.env.COORDINATOR_GENERATION ?? 0),
  });
  const authorized = (req: IncomingMessage): boolean => {
    const presented = req.headers['x-platform-internal-key'];
    return (
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') &&
      req.headers['x-platform-instance-id'] === instanceId &&
      typeof presented === 'string' &&
      Buffer.byteLength(presented) === Buffer.byteLength(key) &&
      timingSafeEqual(Buffer.from(presented), Buffer.from(key))
    );
  };
  async function adopt(input: Record<string, unknown>) {
    requireUpgrade(
      !['draining', 'drained', 'unknown'].includes(workers.snapshot().state),
      'PREPARED_COORDINATOR_RETIRING',
    );
    requireUpgrade(
      input.instanceId === instanceId &&
        input.startIdentity === process.env.PLATFORM_PROCESS_START_IDENTITY,
      'PREPARED_COORDINATOR_IDENTITY_MISMATCH',
    );
    const id = String(input.attemptId),
      fence = Number(input.fence);
    store.assertFence(id, fence);
    const snapshot = store.snapshot(id);
    const row = store.sqlite
      .prepare<unknown[], HandoffRow>('SELECT * FROM coordinator_handoffs WHERE attempt_id=?')
      .get(id);
    requireUpgrade(
      row &&
        row.operation_id === input.operationId &&
        row.plan_digest === input.planDigest &&
        snapshot.plan.planDigest === input.planDigest,
      'FIXED_HANDOFF_INTENT_REQUIRED',
    );
    if (adopting) {
      requireUpgrade(adoptedIntent === input.operationId, 'HANDOFF_INTENT_CONFLICT');
      return adopting;
    }
    if (row.stage === 'adopted' && row.evidence) return upgradeRecord(JSON.parse(row.evidence));
    requireUpgrade(
      state === 'prepared' &&
        row.stage === 'releasing' &&
        snapshot.manifest.components.coordinator.artifactDigest ===
          process.env.PLATFORM_ARTIFACT_DIGEST,
      'WRITER_NOT_RELEASED_OR_CANDIDATE_CHANGED',
    );
    adopting = (async () => {
      adoptedIntent = String(input.operationId);
      state = 'adopting';
      workers.beginLifecycleTransition();
      assertCurrentBusinessAction();
      const budget = new CoordinatorHandoffBudget(
        Number(row.quiesced_at) + snapshot.plan.policy.requestDeadlineMs,
        clock,
        (work) => managementWorker.run(work),
      );
      const generation = activatePreparedPlatform();
      const adoptedWriter = coordinatorWriterControl(store.sqlite);
      const adoptedWriterFence = adoptedWriter.fence;
      process.env.PLATFORM_PROCESS_ROLE = 'coordinator';
      store.sqlite
        .prepare(
          "UPDATE coordinator_handoffs SET stage='adopting',target_generation=? WHERE attempt_id=?",
        )
        .run(generation, id);
      const evidence = await completePreparedCoordinatorAdoption({
        store,
        row,
        fence,
        generation,
        clock,
        budget,
        owners,
        initialize: () => {
          moduleInitializationStarted = true;
          return withoutBusinessAction(() => initializeBusinessTransport());
        },
        seal: () => {
          requireUpgrade(
            sealCoordinatorWorkerManifest(app, workers, { prepared: true }).qualified,
            'COORDINATOR_WORKER_COVERAGE_UNKNOWN',
          );
        },
        continuity: async () =>
          app
            .get((await import('../platform/upgrade/upgrade-inspector')).UpgradeInspector)
            .continuity(id, fence, budget),
        assertAuthority: () => {
          assertCurrentBusinessAction();
          store.assertFence(id, fence);
          adoptedWriter.assert();
          requireUpgrade(
            adoptedWriter.generation === generation && adoptedWriter.fence === adoptedWriterFence,
            'HANDOFF_WRITER_EPOCH_CHANGED',
          );
        },
        transportReady: () => preparedCoordinatorBusinessTransportReady(app),
        setBusinessReady: (ready) => {
          businessReady = ready;
        },
        binding: {
          path: requiredUpgradeValue(process.env.PLATFORM_COORDINATOR_BINDING_PATH),
          origin: `http://${env.host}:${String(env.port)}`,
          artifactDigest: process.env.PLATFORM_ARTIFACT_DIGEST ?? null,
        },
      });
      budget.assert();
      assertCurrentBusinessAction();
      store.assertFence(id, fence);
      adoptedWriter.assert();
      requireUpgrade(
        adoptedWriter.generation === generation &&
          adoptedWriter.fence === adoptedWriterFence &&
          preparedCoordinatorBusinessTransportReady(app),
        'HANDOFF_WRITER_EPOCH_OR_LISTENER_CHANGED',
      );
      state = 'ready';
      withoutBusinessAction(() => {
        quota.startAfterReady();
        taskRecovery.startAfterReady();
      });
      return { commitKnown: true, stage: 'adopted', evidence };
    })().catch((error: unknown) => {
      businessReady = false;
      state = 'unknown';
      workers.invalidateCoverage();
      throw error;
    });
    return adopting;
  }
  const management = createServer((req, res) => {
    const maintenance =
      (req.method === 'GET' && req.url === '/internal/coordinator/retirement') ||
      (req.method === 'POST' && req.url === '/internal/coordinator/retirement-drain');
    if (!maintenance) retirement.request(req, res);
    const work = () => managementRequest(req, res);
    void (maintenance ? work() : retirement.run(work)).catch(() => res.destroy());
  });
  async function managementRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      requireUpgrade(authorized(req), 'PREPARED_INTERNAL_AUTH', 403);
      let value: unknown;
      if (req.method === 'GET' && req.url === '/internal/coordinator/retirement') {
        value = normalRetirement.census();
      } else if (req.method === 'POST' && req.url === '/internal/coordinator/retirement-drain') {
        let body = '';
        for await (const chunk of req) {
          body += String(chunk);
          requireUpgrade(Buffer.byteLength(body) <= 4096, 'RETIREMENT_BODY_TOO_LARGE', 413);
        }
        value = await normalRetirement.close(JSON.parse(body));
        res.statusCode = 202;
      } else if (req.method === 'GET' && req.url === '/internal/coordinator/identity')
        value = identity();
      else if (req.method === 'POST' && req.url === '/internal/coordinator/adopt') {
        let body = '';
        for await (const chunk of req) {
          body += String(chunk);
          requireUpgrade(body.length <= 8192, 'HANDOFF_COMMAND_TOO_LARGE', 413);
        }
        const input = upgradeRecord(JSON.parse(body));
        value = await store.businessAction(
          req.headers,
          String(input.attemptId),
          'coordinatorHandoff',
          input,
          () => adopt(input),
          true,
        );
      } else if (
        req.method === 'POST' &&
        req.url === '/internal/coordinator/participant-command-status'
      ) {
        let body = '';
        for await (const chunk of req) {
          body += String(chunk);
          requireUpgrade(body.length <= 1024, 'PARTICIPANT_STATUS_TOO_LARGE', 413);
        }
        const input = upgradeRecord(JSON.parse(body));
        requireUpgrade(
          Object.keys(input).every((k) => ['attemptId', 'commandId'].includes(k)) &&
            typeof input.attemptId === 'string' &&
            typeof input.commandId === 'string',
          'PARTICIPANT_STATUS_INVALID',
          400,
        );
        value = store.participantCommandStatus(input.attemptId, input.commandId);
      } else if (req.method === 'GET' && req.url === '/internal/coordinator/status')
        value = identity();
      else requireUpgrade(false, 'PREPARED_METHOD_FORBIDDEN', 404);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
    } catch (error) {
      res.statusCode = error instanceof HttpException ? error.getStatus() : 409;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          code:
            error && typeof error === 'object' && 'code' in error
              ? error.code
              : 'HANDOFF_UNCONFIRMED',
          state,
        }),
      );
    }
  }
  await new Promise<void>((ok, fail) => {
    management.once('error', fail);
    management.listen(Number(process.env.COORDINATOR_PREPARED_PORT), '127.0.0.1', ok);
  });
  recoveryWatch = store.ledgerReadonly
    ? undefined
    : managementWorker.ownInterval(
        setInterval(() => {
          if (state !== 'prepared' || adopting) return;
          const row = store.sqlite
            .prepare<unknown[], HandoffRow>(
              "SELECT * FROM coordinator_handoffs WHERE stage='releasing' ORDER BY rowid DESC LIMIT 1",
            )
            .get();
          if (!row) return;
          const candidate = upgradeRecord(JSON.parse(row.candidate));
          if (
            candidate.startIdentity !== process.env.PLATFORM_PROCESS_START_IDENTITY ||
            candidate.artifactDigest !== process.env.PLATFORM_ARTIFACT_DIGEST
          )
            return;
          const writer = store.sqlite
            .prepare<unknown[], { generation: number; expires_at: number }>(
              "SELECT generation,expires_at FROM platform_role_leases WHERE role='state-coordinator'",
            )
            .get();
          if (
            writer?.generation !== row.source_generation ||
            writer.expires_at > clock.now().getTime()
          )
            return;
          const attempt = store.snapshot(row.attempt_id);
          void managementWorker
            .run(() =>
              adopt({
                instanceId,
                attemptId: row.attempt_id,
                fence: attempt.fence,
                operationId: row.operation_id,
                planDigest: row.plan_digest,
                startIdentity: candidate.startIdentity,
              }),
            )
            .catch(() => {
              /* Preserve unknown intent, never restart resources or a new upgrade. */
            });
        }, 10),
      );
  recoveryWatch?.unref();
  sealCoordinatorWorkerManifest(app, workers, { prepared: true, dormant: true });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      managementWorker.cancel(recoveryWatch);
      management.close();
      void app.close();
    });
}
if (require.main === module)
  void startPreparedCoordinator().catch(() => {
    console.error('PREPARED_COORDINATOR_BOOT_FAILED');
    process.exitCode = 1;
  });
