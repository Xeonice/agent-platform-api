import { upgradeRecord, upgradeRecords } from './upgrade-values';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { SANDBOX_PROVIDER_REGISTRY } from '@platform/contracts';
import { RuntimeOwnerProviderRegistry } from '@platform/sandbox';
import { readFile } from 'node:fs/promises';
import { UpgradeStore } from './upgrade-store';
import { loopbackOrigin, UpgradeInspector } from './upgrade-inspector';
import { canonicalUpgrade, requireUpgrade } from './upgrade-trust';
import { writeInstalledBinding } from './upgrade-atomic-file';
import { assertCurrentBusinessAction, withoutBusinessAction } from './upgrade-business-action';

type Json = Record<string, unknown>;
interface Handoff {
  operation_id: string;
  plan_digest: string;
  candidate: string;
  stage: string;
  evidence: string;
}
@Injectable()
export class UpgradeRoleHandoffs {
  constructor(
    private readonly store: UpgradeStore,
    private readonly inspector: UpgradeInspector,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly owners: RuntimeOwnerProviderRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}
  async execute(id: string, kind: 'owner' | 'installer', input: Json): Promise<Json> {
    requireUpgrade(
      !(this.store.ledgerReadonly && kind === 'installer' && input.action !== 'status'),
      'STABLE_CONTROL_INSTALLER_HANDOFF_FORBIDDEN',
    );
    requireUpgrade(
      typeof input.operationId === 'string' &&
        typeof input.planDigest === 'string' &&
        ['prepare', 'adopt', 'status'].includes(String(input.action)),
      'FIXED_ROLE_HANDOFF_COMMAND_REQUIRED',
    );
    const row = this.store.sqlite
      .prepare<unknown[], Handoff>(
        'SELECT * FROM upgrade_role_handoffs WHERE attempt_id=? AND kind=?',
      )
      .get(id, kind);
    const snapshot = this.store.snapshot(id);
    requireUpgrade(snapshot.plan.planDigest === input.planDigest, 'HANDOFF_PLAN_CHANGED');
    if (row)
      requireUpgrade(
        row.operation_id === input.operationId && row.plan_digest === input.planDigest,
        'HANDOFF_INTENT_CONFLICT',
      );
    if (input.action === 'status') {
      requireUpgrade(row, 'HANDOFF_NOT_FOUND', 404);
      if (row.stage === 'adopted')
        return {
          commitKnown: true,
          authorityTransferred: kind === 'installer',
          applied: true,
          evidence: JSON.parse(row.evidence) as unknown,
        };
      return { commitKnown: true, stage: row.stage, resumeAction: 'adopt', applied: false };
    }
    const fence = Number(input.fence);
    this.store.assertControllerFence(id, fence);
    const candidate = row
      ? upgradeRecord(JSON.parse(row.candidate))
      : upgradeRecord(input.candidate);
    const component =
      kind === 'owner'
        ? snapshot.manifest.components.owner
        : snapshot.manifest.components.installer;
    requireUpgrade(
      component &&
        candidate.artifactDigest === component.artifactDigest &&
        candidate.inputFingerprint === component.inputFingerprint &&
        typeof candidate.startIdentity === 'string',
      'ROLE_ARTIFACT_IDENTITY_REQUIRED',
    );
    if (row && input.candidate)
      requireUpgrade(
        canonicalUpgrade(candidate) === canonicalUpgrade(input.candidate),
        'HANDOFF_CANDIDATE_CHANGED',
      );
    requireUpgrade(this.store.step(id, 'package-verify').applied, 'HANDOFF_PACKAGE_NOT_VERIFIED');
    const observed = await this.inspector.processObserve({
      ...candidate,
      instanceId: this.store.instanceId,
      attemptId: id,
      kind,
    });
    assertCurrentBusinessAction();
    requireUpgrade(observed.qualified === true, 'ROLE_PROCESS_UNCONFIRMED');
    const url = loopbackOrigin(candidate.managementOrigin ?? candidate.origin);
    if (kind === 'installer') {
      const r = await fetch(url + '/metadata', {
        headers: {
          'x-platform-internal-key': process.env.PLATFORM_CONTROLLER_RPC_KEY ?? '',
          'x-platform-instance-id': this.store.instanceId,
        },
        signal: AbortSignal.timeout(1500),
      });
      requireUpgrade(r.ok, 'INSTALLER_IDENTITY_UNKNOWN');
      const metadata = upgradeRecord(await r.json());
      requireUpgrade(
        metadata.artifactDigest === component.artifactDigest &&
          metadata.inputFingerprint === component.inputFingerprint &&
          metadata.startIdentity === candidate.startIdentity &&
          metadata.readyForHandoff === true,
        'INSTALLER_ARTIFACT_CHANGED',
      );
      requireUpgrade(
        this.store.step(id, 'installer-handoff').applied,
        'INSTALLER_RECEIPT_NOT_COMMITTED',
      );
      const evidence = {
        ...observed,
        inputFingerprint: metadata.inputFingerprint,
        qualified: true,
        authorityTransferred: true,
        instanceId: this.store.instanceId,
        observedAt: this.clock.now().toISOString(),
      };
      this.store.sqlite
        .transaction(() => {
          this.store.assertFence(id, fence);
          if (!row)
            this.store.sqlite
              .prepare('INSERT INTO upgrade_role_handoffs VALUES(?,?,?,?,?,?,?)')
              .run(
                id,
                kind,
                input.operationId,
                input.planDigest,
                canonicalUpgrade(candidate),
                'adopted',
                canonicalUpgrade(evidence),
              );
          else
            this.store.sqlite
              .prepare(
                "UPDATE upgrade_role_handoffs SET stage='adopted',evidence=? WHERE attempt_id=? AND kind=?",
              )
              .run(canonicalUpgrade(evidence), id, kind);
          this.store.transferController(id, fence);
        })
        .immediate();
      return { commitKnown: true, authorityTransferred: true, evidence };
    }
    const metadataResponse = await fetch(url + '/runtime/metadata', {
      headers: {
        'x-platform-internal-key': process.env.PLATFORM_COORDINATOR_RPC_KEY ?? '',
        'x-platform-instance-id': this.store.instanceId,
      },
      signal: AbortSignal.timeout(1500),
    });
    requireUpgrade(metadataResponse.ok, 'NEW_OWNER_METADATA_UNKNOWN');
    const metadata = upgradeRecord(await metadataResponse.json());
    assertCurrentBusinessAction();
    requireUpgrade(
      typeof metadata.ownerId === 'string' &&
        metadata.artifactDigest === component.artifactDigest &&
        metadata.inputFingerprint === component.inputFingerprint,
      'NEW_OWNER_IDENTITY_MISMATCH',
    );
    if (!row) {
      await withoutBusinessAction(() =>
        this.owners.addOwner(
          {
            endpoint: url,
            instanceId: this.store.instanceId,
            key: process.env.PLATFORM_COORDINATOR_RPC_KEY ?? '',
            generation: Number(process.env.COORDINATOR_GENERATION),
            clock: this.clock,
          },
          false,
        ),
      );
      assertCurrentBusinessAction();
      this.store.assertFence(id, fence);
      this.store.sqlite
        .prepare('INSERT INTO upgrade_role_handoffs VALUES(?,?,?,?,?,?,?)')
        .run(
          id,
          kind,
          input.operationId,
          input.planDigest,
          canonicalUpgrade(candidate),
          'prepared',
          canonicalUpgrade(observed),
        );
    }
    if (input.action === 'prepare')
      return { commitKnown: true, stage: 'prepared', evidence: observed };
    const proof = await this.inspector.continuity(id, fence);
    assertCurrentBusinessAction();
    requireUpgrade(proof.qualified === true, 'ORIGINAL_OWNER_UNCONFIRMED');
    const path = process.env.PLATFORM_RUNTIME_OWNER_BINDING_PATH;
    requireUpgrade(path, 'OWNER_BINDING_PATH_REQUIRED');
    let previous: Json = {
      instanceId: this.store.instanceId,
      activeOwnerId: this.owners.activeOwnerId,
      owners: this.owners.installedRoutes(),
    };
    try {
      previous = upgradeRecord(JSON.parse(await readFile(path, 'utf8')));
    } catch {
      /* First installed route set uses the existing private installation endpoint. */
    }
    requireUpgrade(
      previous.instanceId === this.store.instanceId && Array.isArray(previous.owners),
      'OWNER_BINDING_SCOPE_MISMATCH',
    );
    const routes = upgradeRecords(previous.owners);
    if (!routes.some((v) => v.ownerId === metadata.ownerId))
      routes.push({
        ownerId: metadata.ownerId,
        endpoint: url,
        artifactDigest: component.artifactDigest,
        inputFingerprint: component.inputFingerprint,
      });
    const binding = {
      instanceId: this.store.instanceId,
      activeOwnerId: metadata.ownerId,
      owners: routes,
    };
    // Publish recoverable fixed routing before changing only future allocation.
    assertCurrentBusinessAction();
    await writeInstalledBinding(path, binding);
    assertCurrentBusinessAction();
    this.owners.activateOwner(metadata.ownerId);
    const evidence = {
      ...observed,
      qualified: true,
      originalResourcesPreserved: true,
      assignmentTransfer: false,
      activeOwnerId: metadata.ownerId,
      binding,
      observedAt: this.clock.now().toISOString(),
    };
    this.store.sqlite
      .prepare(
        "UPDATE upgrade_role_handoffs SET stage='adopted',evidence=? WHERE attempt_id=? AND kind=?",
      )
      .run(canonicalUpgrade(evidence), id, kind);
    return { commitKnown: true, evidence };
  }
}
