import { coordinatorWorker } from '@platform/shared-kernel';
import { z } from 'zod';
import { UpgradeStatusSchema } from '@platform/contracts';
import { requiredUpgradeValue } from './upgrade-values';
import { upgradeRecord } from './upgrade-values';
import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import type { UpgradeStatus } from '@platform/contracts';
import { UpgradeStore } from './upgrade-store';
import { UpgradeCatalog } from './upgrade-catalog';
import { loopbackOrigin } from './upgrade-inspection-boundary';
import {
  UPGRADE_INSPECTOR,
  UPGRADE_CONTRACT_SERVICE,
  type UpgradeInspectionPort,
} from './upgrade-inspection.port';
import type { UpgradeContractService } from './upgrade-contract-service';
import { requireUpgrade, upgradeDigest } from './upgrade-trust';
import { withUpgradeObservation } from './upgrade-observation';
import { withCoordinatorBusinessEpoch } from '../persistence/coordinator-lease';

interface PhysicalObservation {
  activationGeneration: number;
  durableState: UpgradeStatus['serviceState'];
  durableReady: number;
  serviceState: UpgradeStatus['serviceState'];
  availableWeb: UpgradeStatus['availableWeb'];
  repairableCurrent: UpgradeStatus['repairableCurrent'];
  serviceAvailability: NonNullable<UpgradeStatus['serviceAvailability']>;
  confirmedAt: string;
}
const PhysicalObservationSchema = z.object({
  activationGeneration: z.number(),
  durableState: UpgradeStatusSchema.shape.serviceState,
  durableReady: z.number(),
  serviceState: UpgradeStatusSchema.shape.serviceState,
  availableWeb: UpgradeStatusSchema.shape.availableWeb,
  repairableCurrent: UpgradeStatusSchema.shape.repairableCurrent,
  serviceAvailability: UpgradeStatusSchema.shape.serviceAvailability.unwrap(),
  confirmedAt: z.string(),
});
function assertPhysicalObservation(value: unknown): asserts value is PhysicalObservation {
  PhysicalObservationSchema.parse(value);
}
const ROLE = 'upgrade-observation';
const FRESHNESS_MS = 5000;

/** UI projections never authorize installation, migration or routing. The live
 * Inspector remains mandatory at every actual side-effect/confirmation gate. */
@Injectable()
export class UpgradeProjection implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly worker = coordinatorWorker('upgrade.projection');

  private physical: Promise<void> | null = null;
  private metadata: Promise<void> | null = null;
  private contractRead: Promise<void> | null = null;
  private contract: {
    value: UpgradeStatus['contract'];
    confirmedAt: string;
    activationGeneration: number;
    durableState: UpgradeStatus['serviceState'];
    durableReady: number;
  } | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private checkedAt: string | null = null;
  private reason: string | null = null;
  constructor(
    private readonly store: UpgradeStore,
    private readonly catalog: UpgradeCatalog,
    @Inject(UPGRADE_INSPECTOR) private readonly inspector: UpgradeInspectionPort,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional()
    @Inject(UPGRADE_CONTRACT_SERVICE)
    private readonly contracts?: UpgradeContractService,
  ) {}
  onApplicationBootstrap(): void {
    if (this.store.ledgerReadonly) return;
    if (process.env.PLATFORM_PROCESS_ROLE !== 'coordinator') return;
    this.timer = this.worker.ownInterval(
      setInterval(() => {
        this.schedule();
      }, 1000),
    );
    this.timer.unref();
  }
  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) this.worker.cancel(this.timer);
  }
  private writer<T>(work: () => T): T {
    return withCoordinatorBusinessEpoch(this.store.sqlite, work);
  }
  schedule(): void {
    if (
      this.stopped ||
      this.store.ledgerReadonly ||
      (process.env.PLATFORM_PROCESS_ROLE === 'coordinator' &&
        process.env.COORDINATOR_WRITER_FENCE_VALID !== 'true')
    )
      return;
    // Defer all synchronous setup/JSON/tree work until after the read response.
    this.worker.immediate(() => {
      if (this.stopped) return;
      try {
        void this.writer(() =>
          withUpgradeObservation(() => {
            this.physical ??= this.refreshPhysical()
              .catch(() => undefined)
              .finally(() => {
                this.physical = null;
              });
            this.metadata ??= this.catalog
              .refresh()
              .catch(() => undefined)
              .finally(() => {
                this.metadata = null;
              });
            if (this.contracts && !this.contractRead)
              this.contractRead = (async () => {
                const before = this.store.instance();
                const value = await requiredUpgradeValue(this.contracts).status();
                const after = this.store.instance();
                this.contract =
                  before.activation_generation === after.activation_generation &&
                  before.service_state === after.service_state &&
                  before.ready === after.ready
                    ? {
                        value,
                        confirmedAt: this.clock.now().toISOString(),
                        activationGeneration: before.activation_generation,
                        durableState: before.service_state,
                        durableReady: before.ready,
                      }
                    : null;
              })()
                .catch(() => {
                  this.contract = null;
                })
                .finally(() => {
                  this.contractRead = null;
                });
            return Promise.resolve();
          }),
        ).catch(() => undefined);
      } catch {
        // A retained/retired Coordinator must not launch or persist observations.
      }
    });
  }
  private saved(): PhysicalObservation | null {
    try {
      const row = this.store.ledgerSqlite
        .prepare<unknown[], { result: string; request_digest: string }>(
          'SELECT result,request_digest FROM platform_operations WHERE operation_id=? AND instance_id=? AND role=?',
        )
        .get(`${ROLE}:${this.store.instanceId}`, this.store.instanceId, ROLE);
      if (!row) return null;
      const observation: unknown = JSON.parse(row.result);
      assertPhysicalObservation(observation);
      return upgradeDigest(observation) === row.request_digest ? observation : null;
    } catch {
      return null;
    }
  }
  view() {
    const row = this.store.instance(),
      saved = this.saved();
    const age = saved ? this.clock.now().getTime() - Date.parse(saved.confirmedAt) : Infinity;
    const same =
      saved?.activationGeneration === row.activation_generation &&
      saved.durableState === row.service_state &&
      saved.durableReady === row.ready;
    const fresh = same && age >= 0 && age <= FRESHNESS_MS;
    const serviceState = fresh
      ? saved.serviceState
      : row.service_state === 'transitioning'
        ? 'transitioning'
        : 'unknown';
    const availabilityAge = saved?.serviceAvailability.observedAt
      ? this.clock.now().getTime() - Date.parse(saved.serviceAvailability.observedAt)
      : Infinity;
    const availabilityFresh = same && availabilityAge >= 0 && availabilityAge <= FRESHNESS_MS;
    const contractAge = this.contract
      ? this.clock.now().getTime() - Date.parse(this.contract.confirmedAt)
      : Infinity;
    const contract =
      this.contract?.activationGeneration === row.activation_generation &&
      this.contract.durableState === row.service_state &&
      this.contract.durableReady === row.ready &&
      contractAge >= 0 &&
      contractAge <= FRESHNESS_MS
        ? this.contract.value
        : null;
    return {
      serviceState,
      availableWeb: fresh ? saved.availableWeb : null,
      repairableCurrent: fresh ? saved.repairableCurrent : null,
      serviceAvailability: availabilityFresh
        ? saved.serviceAvailability
        : {
            state: 'unknown' as const,
            observedAt: saved?.serviceAvailability.observedAt ?? null,
            reason: 'SERVICE_OBSERVATION_STALE',
          },
      observation: {
        state: fresh ? ('fresh' as const) : saved ? ('stale' as const) : ('checking' as const),
        confirmedAt: saved?.confirmedAt ?? null,
        checkedAt: this.checkedAt,
        reason: fresh
          ? null
          : (this.reason ?? (saved ? 'SERVICE_OBSERVATION_STALE' : 'SERVICE_OBSERVATION_PENDING')),
      },
      contract,
    };
  }
  async refreshPhysical(): Promise<void> {
    return this.worker.run(async () => {
      const row = this.store.instance(),
        last = this.store.confirmed();
      const started = this.clock.now().toISOString();
      this.checkedAt = started;
      let serviceState = row.service_state;
      let availableWeb: UpgradeStatus['availableWeb'] = null;
      let repairableCurrent: UpgradeStatus['repairableCurrent'] = null;
      let availability: PhysicalObservation['serviceAvailability'] = {
        state: 'unknown',
        observedAt: null,
        reason: 'ENTRY_OBSERVATION_UNKNOWN',
      };
      if (row.service_state === 'confirmed' && last) {
        try {
          const binding = await this.inspector.entryBinding(),
            proof = await this.inspector.installedProof(last, binding),
            actual = await this.inspector.webBuild(binding);
          requireUpgrade(
            proof.qualified === true &&
              actual.webRevision === last.components.web.webRevision &&
              upgradeRecord(binding.web).digest === last.components.web.artifactDigest,
            'CURRENT_SERVICE_UNCONFIRMED',
          );
          if (row.ready === 1)
            availableWeb = {
              releaseId: last.releaseId,
              webReleaseId: actual.releaseId,
              webRevision: actual.webRevision,
              artifactDigest: last.components.web.artifactDigest,
              instanceId: this.store.instanceId,
              activationGeneration: last.activationGeneration,
              productionBinding: last.productionWebBinding,
              ready: true,
              compatible: true,
              observedAt: started,
            };
        } catch {
          serviceState = 'unknown';
        }
      }
      if (serviceState !== 'confirmed') {
        try {
          const actual = await this.inspector.sourceActual();
          if (actual)
            repairableCurrent = {
              baseConfirmedReleaseId: actual.baseConfirmedReleaseId,
              activationGeneration: actual.activationGeneration,
              observedAt: actual.observedAt,
            };
        } catch {
          /* Unknown repair proof grants no mutation capability. */
        }
      }
      try {
        const response = await fetch(
          loopbackOrigin(process.env.PLATFORM_ENTRY_ORIGIN) + '/api/health',
          { signal: AbortSignal.timeout(2000) },
        );
        const health: unknown = await response.json();
        availability = {
          state:
            response.ok &&
            health !== null &&
            typeof health === 'object' &&
            'status' in health &&
            health.status === 'ok'
              ? 'available'
              : 'unavailable',
          observedAt: this.clock.now().toISOString(),
          reason: response.ok ? null : 'ENTRY_HEALTH_FAILED',
        };
      } catch {
        /* Unreachable observation is unknown, not proof the platform stopped. */
      }
      const current = this.store.instance();
      if (
        current.activation_generation !== row.activation_generation ||
        current.service_state !== row.service_state ||
        current.ready !== row.ready
      )
        return;
      const snapshot: PhysicalObservation = {
        activationGeneration: row.activation_generation,
        durableState: row.service_state,
        durableReady: row.ready,
        serviceState,
        availableWeb,
        repairableCurrent,
        serviceAvailability: availability,
        confirmedAt: repairableCurrent?.observedAt ?? started,
      };
      const now = this.clock.now().getTime();
      this.store.ledgerSqlite
        .prepare(
          'INSERT INTO platform_operations(operation_id,instance_id,actor_id,role,fence,request_digest,state,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET request_digest=excluded.request_digest,state=excluded.state,result=excluded.result,updated_at=excluded.updated_at',
        )
        .run(
          `${ROLE}:${this.store.instanceId}`,
          this.store.instanceId,
          'system',
          ROLE,
          0,
          upgradeDigest(snapshot),
          'observed',
          JSON.stringify(snapshot),
          now,
          now,
        );
      this.reason = null;
    });
  }
}
