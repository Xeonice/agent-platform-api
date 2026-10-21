import type {
  CallHandler,
  ExecutionContext,
  INestApplication,
  NestInterceptor,
} from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { CLOCK, isRecord, type Clock, type CoordinatorWorkRegistry } from '@platform/shared-kernel';
import { SANDBOX_PROVIDER_REGISTRY } from '@platform/contracts';
import type { RuntimeOwnerProviderRegistry } from '@platform/sandbox';
import { RuntimeApplicationService } from '@platform/runtime';
import { ControlApplicationRegistry } from '../control-rpc/control-rpc.module';
import { coordinatorWriterControl } from '../persistence/coordinator-lease';
import { UpgradeStore } from './upgrade-store';
import { requireUpgrade, upgradeDigest, UpgradeError } from './upgrade-trust';

const GET_PATH = '/internal/application/retirement';
const DRAIN_PATH = '/internal/application/retirement-drain';
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const targetIdentity = z.object({ startIdentity: id, artifactDigest: hash }).strict();
const drainInput = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: id,
    operationId: z.string().uuid(),
    epoch: z.number().int().positive(),
    executorId: id,
    target: targetIdentity,
    intentDigest: hash,
  })
  .strict();
const frozenIntent = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('normal-retirement'),
    instanceId: id,
    operationId: z.string().uuid(),
    acceptedUpgradeId: z.string().uuid(),
    acceptedPlanDigest: hash,
    requestId: z.string().uuid().optional(),
    target: targetIdentity
      .extend({
        instanceId: id,
        role: z.literal('coordinator'),
        containerId: z.string().regex(/^[a-f0-9]{64}$/),
        hostPid: z.number().int().positive(),
        startedAt: z.string().datetime(),
        attemptId: z.string().uuid(),
      })
      .strict(),
    deadline: z.number().int().positive(),
    budget: z.object({ maxDurationMs: z.number().int().positive().max(120000) }).strict(),
  })
  .strict();
type Drain = z.infer<typeof drainInput>;
type OwnerReferences = ReturnType<RuntimeOwnerProviderRegistry['transportReferences']>;
interface RetirementPorts {
  registry: CoordinatorWorkRegistry;
  store: UpgradeStore;
  identity(): unknown;
  closeAdmission(): void;
  ownerReferences(): OwnerReferences;
  authCount(): number;
  writer(): boolean | null;
  clock: Clock;
  httpCount?(): number;
  managementWork?(): number;
  beforeClose?(): void;
}

/** Read-only authority checks never mint a lease or alter the accepted upgrade.
 * The only local mutation is closing this non-writer's work admission. */
export function createNormalCoordinatorRetirement(p: RetirementPorts) {
  let drain: { operationId: string; intentDigest: string; admissionClosed: true } | null = null;
  function identity(): Record<string, unknown> {
    const actual = p.identity();
    requireUpgrade(
      isRecord(actual) &&
        actual.instanceId === p.store.instanceId &&
        ['coordinator', 'coordinator-prepared'].includes(String(actual.role)) &&
        typeof actual.startIdentity === 'string' &&
        typeof actual.artifactDigest === 'string',
      'RETIREMENT_IDENTITY_UNKNOWN',
    );
    return actual;
  }
  function census() {
    const actual = identity(),
      workers = p.registry.snapshot(),
      owners = p.ownerReferences();
    const httpWorker = workers.workers.find((worker) => worker.id === 'platform.http');
    const recoveryWorker = workers.workers.find(
      (worker) => worker.id === 'upgrade.coordinator-recovery',
    );
    const management = p.managementWork?.() ?? 0;
    const count = (value: unknown): number | null =>
      Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
    const ownerCount = owners.complete ? owners.http + owners.observers + owners.renewals : null;
    const writer = p.writer();
    const counts = {
      http: count(p.httpCount?.() ?? actual.activeRequests),
      ws: count(actual.activeTransportConnections),
      streams: count(actual.activeStreams),
      workers: workers.active + workers.queued + workers.stopPending + management,
      owners: ownerCount,
      guests: ownerCount,
      handoff: (httpWorker?.active ?? 0) + management,
      recovery: (recoveryWorker?.active ?? 0) + management,
      userOperations: count(
        Number(actual.activeRequests) +
          Number(actual.activeMutations) +
          p.authCount() +
          workers.active +
          workers.userQueued +
          management,
      ),
    };
    const complete =
      workers.sealed &&
      workers.coverageComplete &&
      workers.state !== 'unknown' &&
      owners.complete &&
      writer !== null &&
      Object.values(counts).every((value) => value !== null);
    return {
      schemaVersion: 1,
      ...actual,
      generation: actual.coordinatorGeneration,
      role: 'coordinator',
      observedAt: p.clock.now().toISOString(),
      complete,
      writer,
      counts,
      workerCoverage: {
        sealed: workers.sealed,
        complete: workers.coverageComplete,
        state: workers.state,
        manifestDigest: upgradeDigest(workers.workers.map((worker) => worker.id)),
        registered: workers.workers.length,
      },
      drain: drain
        ? {
            ...drain,
            settled:
              complete &&
              workers.state === 'drained' &&
              Object.values(counts).every((value) => value === 0) &&
              !writer,
          }
        : null,
    };
  }
  function authorize(input: Drain): void {
    const actual = identity(),
      now = p.clock.now().getTime();
    requireUpgrade(
      input.instanceId === p.store.instanceId &&
        input.target.startIdentity === actual.startIdentity &&
        input.target.artifactDigest === actual.artifactDigest,
      'RETIREMENT_TARGET_CHANGED',
    );
    const ledger = p.store.ledgerSqlite;
    requireUpgrade(ledger.readonly, 'RETIREMENT_READONLY_AUTHORITY_REQUIRED');
    const authority: unknown = ledger
      .prepare('SELECT * FROM control_authority WHERE instance_id=?')
      .get(input.instanceId);
    requireUpgrade(
      isRecord(authority) &&
        authority.mode === 'active' &&
        authority.kind === 'maintenance' &&
        authority.operation_id === input.operationId &&
        authority.epoch === input.epoch &&
        authority.holder_id === input.executorId &&
        Number(authority.lease_expires_at) > now,
      'RETIREMENT_MAINTENANCE_AUTHORITY_REQUIRED',
    );
    const row: unknown = ledger
      .prepare('SELECT * FROM control_normal_retirements WHERE operation_id=? AND instance_id=?')
      .get(input.operationId, input.instanceId);
    requireUpgrade(
      isRecord(row) &&
        typeof row.intent === 'string' &&
        row.intent.length <= 16384 &&
        row.intent_digest === input.intentDigest &&
        ['prepared', 'drain-dispatched', 'draining'].includes(String(row.state)),
      'RETIREMENT_INTENT_REQUIRED',
    );
    const intent = frozenIntent.parse(JSON.parse(row.intent));
    requireUpgrade(
      upgradeDigest(intent) === input.intentDigest &&
        intent.instanceId === input.instanceId &&
        intent.operationId === input.operationId &&
        intent.target.startIdentity === actual.startIdentity &&
        intent.target.artifactDigest === actual.artifactDigest &&
        intent.target.attemptId === intent.acceptedUpgradeId &&
        intent.deadline > now,
      'RETIREMENT_INTENT_CHANGED',
    );
    const snapshot = p.store.snapshot(intent.acceptedUpgradeId);
    requireUpgrade(
      ['activation-confirmed', 'deferred', 'candidate-rejected', 'failed', 'reverted'].includes(
        snapshot.attempt.state,
      ) &&
        snapshot.attempt.instanceId === input.instanceId &&
        snapshot.plan.planDigest === intent.acceptedPlanDigest &&
        snapshot.manifest.components.coordinator.artifactDigest === input.target.artifactDigest,
      'RETIREMENT_ACCEPTED_PLAN_REQUIRED',
    );
    requireUpgrade(p.writer() === false, 'RETIREMENT_WRITER_STILL_ACTIVE');
  }
  async function close(input: unknown) {
    const parsed = drainInput.parse(input);
    authorize(parsed);
    p.beforeClose?.();
    requireUpgrade(
      !drain ||
        (drain.operationId === parsed.operationId && drain.intentDigest === parsed.intentDigest),
      'RETIREMENT_DRAIN_INTENT_CONFLICT',
    );
    const before = census();
    requireUpgrade(
      before.complete &&
        before.counts.http === 0 &&
        before.counts.ws === 0 &&
        before.counts.streams === 0 &&
        before.counts.owners === 0 &&
        before.counts.guests === 0 &&
        before.counts.handoff === 0 &&
        before.counts.recovery === 0 &&
        before.counts.userOperations === 0,
      'RETIREMENT_REFERENCES_STILL_ACTIVE',
    );
    // No await separates the fresh global grant/actual writer check from closing
    // local admission. Existing work is retained until its original finally.
    p.closeAdmission();
    const stopping = p.registry.stop();
    drain = {
      operationId: parsed.operationId,
      intentDigest: parsed.intentDigest,
      admissionClosed: true,
    };
    // Accepted closes admission now. The independently observed stopPending
    // retains real flush/drain Promises; the HTTP acknowledgement need not wait.
    void stopping;
    // Run the synchronously scheduled stop-admission hooks before acknowledging
    // the closed gate; long drain/flush Promises remain independently observed.
    await Promise.resolve();
    return { accepted: true, ...drain };
  }
  return { census, close };
}

/** Owns the original Nest handler subscription. HTTP disconnect/abort never
 * unsubscribes or clears the separately retained Promise. */
class CoordinatorRetirementInterceptor implements NestInterceptor {
  private readonly worker;
  constructor(registry: CoordinatorWorkRegistry) {
    this.worker = registry.register('platform.http');
  }
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    // Fixed synchronous, independently authenticated identity remains readable
    // after admission closes so Supervisor can verify the original participant.
    if (req.method === 'GET' && req.originalUrl === '/internal/application/identity')
      return next.handle();
    return new Observable((subscriber) => {
      if (this.worker.snapshot().stopped) {
        subscriber.error(
          new HttpException(
            {
              code: 'COORDINATOR_WORKER_DRAINING',
              message: '当前服务已停止接收新工作，请刷新后查看实例状态',
              retryable: false,
              sideEffectFree: true,
            },
            503,
          ),
        );
        return;
      }
      const transportError = (error: unknown): unknown =>
        isRecord(error) && error.code === 'COORDINATOR_WORKER_DRAINING'
          ? new HttpException(
              {
                code: 'COORDINATOR_WORKER_DRAINING',
                message: '当前服务已停止接收新工作，请刷新后查看实例状态',
                retryable: false,
              },
              503,
            )
          : error;
      // Hold one original subscription until its real complete/error. The
      // downstream consumer can disappear while that original work is still live.
      void this.worker
        .run(
          () =>
            new Promise<void>((resolve, reject) => {
              next.handle().subscribe({
                next: (value) => {
                  subscriber.next(value);
                },
                error: (error: unknown) => {
                  subscriber.error(transportError(error));
                  reject(
                    error instanceof Error ? error : new Error('Coordinator handler rejected'),
                  );
                },
                complete: () => {
                  subscriber.complete();
                  resolve();
                },
              });
            }),
        )
        .catch((error: unknown) => {
          subscriber.error(transportError(error));
        });
      return () => {
        /* Original handler lifetime is independent of the response. */
      };
    });
  }
}

export function installNormalCoordinatorRetirement(
  app: INestApplication,
  registry: CoordinatorWorkRegistry,
  extra: {
    managementWork?(): number;
    managementHttp?(): number;
    beforeClose?(): void;
    writer?(): boolean | null;
  } = {},
) {
  const applications = app.get(ControlApplicationRegistry),
    store = app.get(UpgradeStore),
    owners = app.get<RuntimeOwnerProviderRegistry>(SANDBOX_PROVIDER_REGISTRY),
    runtime = app.get(RuntimeApplicationService),
    clock = app.get<Clock>(CLOCK);
  let http = 0;
  const manager = createNormalCoordinatorRetirement({
    registry,
    store,
    identity: () => applications.identity(),
    closeAdmission: () => {
      applications.closeRetirementAdmission();
    },
    ownerReferences: () => owners.transportReferences(),
    authCount: () => runtime.activeAuthCount(),
    clock,
    httpCount: () => http + (extra.managementHttp?.() ?? 0),
    managementWork: () => extra.managementWork?.() ?? 0,
    beforeClose: () => {
      extra.beforeClose?.();
    },
    writer:
      (extra.writer ? () => extra.writer?.() ?? null : undefined) ??
      (() => {
        try {
          coordinatorWriterControl(store.sqlite).assert();
          return true;
        } catch (error) {
          return error instanceof UpgradeError && error.code === 'COORDINATOR_WRITER_FENCE_EXPIRED'
            ? false
            : null;
        }
      }),
  });
  app.useGlobalInterceptors(new CoordinatorRetirementInterceptor(registry));
  app.use((req: Request, res: Response, next: NextFunction) => {
    const census = req.method === 'GET' && req.url === GET_PATH,
      drain = req.method === 'POST' && req.url === DRAIN_PATH;
    if (!census && !drain) {
      http++;
      let ended = false;
      const finish = () => {
        if (!ended) {
          ended = true;
          http--;
        }
      };
      res.once('finish', finish);
      res.once('close', finish);
      next();
      return;
    }
    const expected = process.env.PLATFORM_CONTROLLER_RPC_KEY,
      supplied = req.headers['x-platform-internal-key'];
    if (
      !expected ||
      expected.length < 32 ||
      typeof supplied !== 'string' ||
      req.headers['x-platform-instance-id'] !== store.instanceId ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') ||
      Buffer.byteLength(expected) !== Buffer.byteLength(supplied) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
    ) {
      res.status(403).json({ code: 'RETIREMENT_INTERNAL_AUTH', retryable: false });
      return;
    }
    const work = async () => {
      if (census) {
        res.json(manager.census());
        return;
      }
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
        requireUpgrade(Buffer.byteLength(body) <= 4096, 'RETIREMENT_BODY_TOO_LARGE', 413);
      }
      const result = await manager.close(JSON.parse(body));
      res.status(202).json(result);
    };
    void work().catch(() => {
      if (!res.headersSent && !res.destroyed)
        res.status(409).json({ code: 'RETIREMENT_DRAIN_NOT_ADMITTED', retryable: false });
    });
  });
  return manager;
}
