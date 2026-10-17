import type {
  ConfirmedServiceRelease,
  SignedUpgradeManifest,
  UpgradePlan,
} from '@platform/contracts';
import { freezeUpgradePlan, requireUpgrade, UpgradeError } from './upgrade-trust';

export interface FixedUpgradeStage {
  envelope: SignedUpgradeManifest;
  plan: UpgradePlan;
}

/** Planning uses signed projected tuples, never records them as actual activations.
 * Every stage is frozen again against the physical source before it is queued. */
export function freezeUpgradeChain(
  target: SignedUpgradeManifest,
  source: ConfirmedServiceRelease,
  catalog: readonly SignedUpgradeManifest[],
  appliedBridges: readonly string[] = [],
): FixedUpgradeStage[] {
  const byRelease = new Map<string, SignedUpgradeManifest>();
  for (const envelope of catalog) {
    const previous = byRelease.get(envelope.manifest.releaseId);
    requireUpgrade(
      !previous || previous.manifestDigest === envelope.manifestDigest,
      'AMBIGUOUS_BRIDGE_RELEASE',
    );
    byRelease.set(envelope.manifest.releaseId, envelope);
  }
  const visit = (
    envelope: SignedUpgradeManifest,
    current: ConfirmedServiceRelease,
    applied: readonly string[],
    visiting: ReadonlySet<string>,
  ): FixedUpgradeStage[] => {
    requireUpgrade(!visiting.has(envelope.manifest.releaseId), 'UPGRADE_CHAIN_CYCLE');
    requireUpgrade(visiting.size < 16, 'UPGRADE_CHAIN_TOO_LONG');
    try {
      return [{ envelope, plan: freezeUpgradePlan(envelope, current, applied) }];
    } catch (error) {
      if (!(error instanceof UpgradeError)) throw error;
      if (!['UPGRADE_PATH_NOT_SUPPORTED', 'REQUIRED_BRIDGE_NOT_INSTALLED'].includes(error.code))
        throw error;
    }
    const nextVisiting = new Set([...visiting, envelope.manifest.releaseId]);
    let lastError: unknown;
    for (const path of envelope.manifest.upgradePaths) {
      const required = [
        ...new Set([
          ...path.bridgeReleases.filter((id) => id !== current.releaseId && !applied.includes(id)),
          ...(path.fromRelease === current.releaseId ? [] : [path.fromRelease]),
        ]),
      ];
      if (required.length === 0) continue;
      try {
        let projected = current;
        const seen = [...applied];
        const stages: FixedUpgradeStage[] = [];
        for (const id of required) {
          if (id === projected.releaseId) continue;
          const bridge = byRelease.get(id);
          requireUpgrade(bridge, 'REQUIRED_BRIDGE_UNAVAILABLE');
          const preceding = visit(bridge, projected, seen, nextVisiting);
          for (const stage of preceding) {
            requireUpgrade(
              !stages.some(
                (s) => s.envelope.manifest.releaseId === stage.envelope.manifest.releaseId,
              ),
              'UPGRADE_CHAIN_CYCLE',
            );
            stages.push(stage);
            projected = projectedRelease(projected, stage);
            seen.push(stage.envelope.manifest.releaseId);
          }
        }
        const finalPlan = freezeUpgradePlan(envelope, projected, seen);
        requireUpgrade(stages.length < 16, 'UPGRADE_CHAIN_TOO_LONG');
        return [...stages, { envelope, plan: finalPlan }];
      } catch (error) {
        if (!(error instanceof UpgradeError)) throw error;
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    throw new UpgradeError('UPGRADE_PATH_NOT_SUPPORTED');
  };
  return visit(target, source, appliedBridges, new Set());
}

function projectedRelease(
  source: ConfirmedServiceRelease,
  stage: FixedUpgradeStage,
): ConfirmedServiceRelease {
  const manifest = stage.envelope.manifest;
  return {
    ...source,
    releaseId: manifest.releaseId,
    activationGeneration: source.activationGeneration + 1,
    schema: stage.plan.migrationPath.targetSchema,
    components: manifest.components,
    commits: manifest.commits,
  };
}
