import { HttpException } from '@nestjs/common';
import { upgradeRecord, requiredUpgradeValue } from '../platform/upgrade/upgrade-values';
import type { HandoffRow } from '../platform/upgrade/coordinator-handoff';
import 'reflect-metadata';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { SANDBOX_PROVIDER_REGISTRY } from '@platform/contracts';
import type { RuntimeOwnerProviderRegistry } from '@platform/sandbox';
import { ImageSeeder } from '@platform/image';
import { PROJECT_READ_PROJECTION, type ProjectReadProjection } from '@platform/project';
import { supportedDataFormats } from '../platform/data-format-capabilities';
import { fromEpochMs } from '@platform/shared-kernel';
import { SystemClock } from '../platform/time/system-clock';
import { env } from '../platform/config/env';
import {
  activatePreparedPlatform,
  platformConnection,
} from '../platform/persistence/platform.module';
import { configurePlatformApp } from '../bootstrap/configure-app';
import { setupWebsockets } from '../bootstrap/websocket.setup';
import { readPublicNetworkConfig } from '../platform/config/public-network';
import { UpgradeStore } from '../platform/upgrade/upgrade-store';
import { writeInstalledBinding } from '../platform/upgrade/upgrade-atomic-file';
import { requireUpgrade } from '../platform/upgrade/upgrade-trust';
import { coordinatorArtifactIdentity } from '../platform/upgrade/coordinator-artifact-identity';
import {
  assertCurrentBusinessAction,
  withoutBusinessAction,
} from '../platform/upgrade/upgrade-business-action';

/** Preconstruct real B providers with read-only DB; no module/startup hook runs. */
export async function startPreparedCoordinator(): Promise<void> {
  const clock = new SystemClock();
  process.env.PLATFORM_PROCESS_ROLE = 'coordinator-prepared';
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
  const { AppModule } = await import('../app.module');
  platformConnection();
  const app = await NestFactory.create(AppModule, { bufferLogs: true, abortOnError: false });
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
  let adopting: Promise<Record<string, unknown>> | null = null;
  let adoptedIntent: string | null = null;
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
      assertCurrentBusinessAction();
      const generation = activatePreparedPlatform();
      process.env.PLATFORM_PROCESS_ROLE = 'coordinator';
      store.sqlite
        .prepare(
          "UPDATE coordinator_handoffs SET stage='adopting',target_generation=? WHERE attempt_id=?",
        )
        .run(generation, id);
      assertCurrentBusinessAction();
      await withoutBusinessAction(() => owners.activateBusinessAuthority(generation));
      assertCurrentBusinessAction();
      const network = readPublicNetworkConfig();
      configurePlatformApp(app, network);
      setupWebsockets(app, network);
      app.enableShutdownHooks();
      await withoutBusinessAction(() => app.listen(env.port, env.host));
      assertCurrentBusinessAction();
      const continuity = await app
        .get((await import('../platform/upgrade/upgrade-inspector')).UpgradeInspector)
        .continuity(id, fence);
      assertCurrentBusinessAction();
      await writeInstalledBinding(
        requiredUpgradeValue(process.env.PLATFORM_COORDINATOR_BINDING_PATH),
        {
          state: 'ready',
          instanceId,
          origin: `http://${env.host}:${String(env.port)}`,
          generation,
          artifactDigest: process.env.PLATFORM_ARTIFACT_DIGEST ?? null,
        },
      );
      const activatedAt = clock.now().getTime(),
        maxControlPauseMs = activatedAt - Number(row.quiesced_at);
      const evidence = {
        qualified:
          maxControlPauseMs <= snapshot.plan.policy.requestDeadlineMs &&
          continuity.qualified === true,
        commitKnown: true,
        singleWriter: true,
        maxControlPauseMs,
        originalResourcesPreserved: continuity.qualified === true,
        instanceId,
        attemptId: id,
        artifactDigest: process.env.PLATFORM_ARTIFACT_DIGEST,
        generation,
        observedAt: fromEpochMs(activatedAt).toISOString(),
      };
      store.sqlite
        .prepare(
          "UPDATE coordinator_handoffs SET stage='adopted',activated_at=?,evidence=? WHERE attempt_id=?",
        )
        .run(activatedAt, JSON.stringify(evidence), id);
      state = 'ready';
      return { commitKnown: true, stage: 'adopted', evidence };
    })().catch((error: unknown) => {
      state = 'unknown';
      throw error;
    });
    return adopting;
  }
  const management = createServer((req, res) => {
    void managementRequest(req, res).catch(() => res.destroy());
  });
  async function managementRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      requireUpgrade(authorized(req), 'PREPARED_INTERNAL_AUTH', 403);
      let value: unknown;
      if (req.method === 'GET' && req.url === '/internal/coordinator/identity') value = identity();
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
  const recoveryWatch = store.ledgerReadonly
    ? undefined
    : setInterval(() => {
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
        void adopt({
          instanceId,
          attemptId: row.attempt_id,
          fence: attempt.fence,
          operationId: row.operation_id,
          planDigest: row.plan_digest,
          startIdentity: candidate.startIdentity,
        }).catch(() => {
          /* Preserve unknown intent, never restart resources or a new upgrade. */
        });
      }, 10);
  recoveryWatch?.unref();
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      clearInterval(recoveryWatch);
      management.close();
      void app.close();
    });
}
if (require.main === module)
  void startPreparedCoordinator().catch(() => {
    console.error('PREPARED_COORDINATOR_BOOT_FAILED');
    process.exitCode = 1;
  });
