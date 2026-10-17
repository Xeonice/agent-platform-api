import { lstat, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import type {
  SignedUpgradeManifest,
  UpgradeStatus,
  UpgradePlan,
  UpgradeSourceActual,
} from '@platform/contracts';
import { UpgradeStore } from './upgrade-store';
import { UpgradeInspector } from './upgrade-inspector';
import { compatibleGlobalSchemaPath } from './image-runtime-schema-plan';
import {
  freezeUpgradePlan,
  readUpgradeTrustRoot,
  requireUpgrade,
  upgradeDigest,
  verifyUpgradeEnvelope,
  UpgradeError,
} from './upgrade-trust';

function newer(a: string, b: string): boolean {
  const parse = (value: string) => value.replace(/^v/, '').split('-');
  const aa = parse(a),
    bb = parse(b),
    av = aa[0].split('.').map(Number),
    bv = bb[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] > bv[i];
  if (aa.length === 1 || bb.length === 1) return aa.length === 1 && bb.length > 1;
  const apre = aa.slice(1).join('-').split('.'),
    bpre = bb.slice(1).join('-').split('.');
  for (let i = 0; i < Math.max(apre.length, bpre.length); i++) {
    if (apre[i] === undefined) return false;
    if (bpre[i] === undefined) return true;
    if (apre[i] === bpre[i]) continue;
    const an = /^\d+$/.test(apre[i]),
      bn = /^\d+$/.test(bpre[i]);
    if (an !== bn) return !an;
    return an ? Number(apre[i]) > Number(bpre[i]) : apre[i] > bpre[i];
  }
  return false;
}

/** Reads signed metadata only. It has no deployment executor or package download capability. */
@Injectable()
export class UpgradeCatalog {
  private projection: UpgradeStatus['catalog'] = {
    state: 'unknown',
    availableRelease: null,
    observedAt: null,
    reason: 'CATALOG_NOT_CHECKED',
  };
  private verified: {
    envelope: SignedUpgradeManifest;
    plan: UpgradePlan;
    sourceActual: UpgradeSourceActual | null;
  } | null = null;
  private refreshing: Promise<void> | null = null;
  constructor(
    private readonly store: UpgradeStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly inspector: UpgradeInspector,
  ) {}
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.read().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  status(): UpgradeStatus['catalog'] {
    return this.projection;
  }
  target(releaseId: string, digest: string) {
    requireUpgrade(
      this.verified &&
        this.verified.envelope.manifest.releaseId === releaseId &&
        this.verified.envelope.manifestDigest === digest,
      'UPGRADE_TARGET_UNAVAILABLE',
    );
    return this.verified;
  }
  private async read(): Promise<void> {
    const observedAt = this.clock.now().toISOString();
    this.verified = null;
    try {
      const path = process.env.UPGRADE_TRUST_ROOT_PATH;
      requireUpgrade(path, 'TRUST_ROOT_MISSING');
      const roots = await readUpgradeTrustRoot(path);
      if (roots.purpose === 'qualification') {
        const proofPath = process.env.UPGRADE_QUALIFICATION_INSTALLATION_PATH;
        requireUpgrade(proofPath, 'QUALIFICATION_INSTALLATION_REQUIRED');
        const stat = await lstat(proofPath);
        requireUpgrade(
          stat.isFile() &&
            !stat.isSymbolicLink() &&
            (stat.mode & 0o077) === 0 &&
            (!process.getuid || stat.uid === process.getuid()),
          'INSECURE_QUALIFICATION_INSTALLATION',
        );
        const proof = JSON.parse(await readFile(proofPath, 'utf8')) as Record<string, unknown>;
        requireUpgrade(
          proof.purpose === 'qualification' &&
            proof.instanceId === this.store.instanceId &&
            proof.trustRootDigest === upgradeDigest(roots) &&
            typeof proof.isolatedRoot === 'string',
          'QUALIFICATION_INSTALLATION_MISMATCH',
        );
        const inside = relative(resolve(proof.isolatedRoot), resolve(process.env.DATA_ROOT ?? ''));
        requireUpgrade(
          inside !== '' && !inside.startsWith('..') && !inside.startsWith('/'),
          'QUALIFICATION_HOME_NOT_ISOLATED',
        );
      }
      let raw: unknown;
      if (process.env.UPGRADE_CATALOG_FILE)
        raw = JSON.parse(await readFile(process.env.UPGRADE_CATALOG_FILE, 'utf8'));
      else {
        const url = new URL(process.env.UPGRADE_CATALOG_URL ?? '');
        requireUpgrade(
          url.protocol === 'https:' &&
            roots.distributionOrigins.includes(url.origin) &&
            !url.username &&
            !url.password,
          'UNTRUSTED_CATALOG_ORIGIN',
        );
        const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' });
        requireUpgrade(response.ok, 'CATALOG_UNAVAILABLE');
        const text = await response.text();
        requireUpgrade(Buffer.byteLength(text) <= 1024 * 1024, 'CATALOG_TOO_LARGE');
        raw = JSON.parse(text);
      }
      requireUpgrade(
        raw &&
          typeof raw === 'object' &&
          'schemaVersion' in raw &&
          raw.schemaVersion === 1 &&
          'releases' in raw &&
          Array.isArray(raw.releases) &&
          raw.releases.length <= 200,
        'INVALID_CATALOG',
      );
      const installed = this.store.confirmed();
      requireUpgrade(installed, 'INSTALLED_RELEASE_UNKNOWN');
      let sourceActual: UpgradeSourceActual | null = null;
      try {
        sourceActual = await this.inspector.sourceActual();
      } catch {
        /* An unqualified partial installation cannot be repaired from metadata alone. */
      }
      if (!sourceActual)
        requireUpgrade(
          (await this.inspector.installedProof(installed)).qualified === true,
          'CURRENT_SERVICE_UNCONFIRMED',
        );
      const planSource = sourceActual
        ? { ...installed, schema: sourceActual.schema, components: sourceActual.components }
        : installed;
      const targets: {
        envelope: SignedUpgradeManifest;
        plan: UpgradePlan;
        sourceActual: UpgradeSourceActual | null;
      }[] = [];
      let incompatibleReason: string | null = null;
      for (const entry of raw.releases) {
        if (!entry || typeof entry !== 'object' || !('envelope' in entry)) continue;
        const envelope = entry.envelope;
        if (!envelope || typeof envelope !== 'object' || !('manifest' in envelope)) continue;
        const manifest = envelope.manifest;
        // Separate qualification instances may share a catalog. This only
        // selects the intended signed envelope; verification is still mandatory.
        if (
          roots.purpose === 'qualification' &&
          manifest &&
          typeof manifest === 'object' &&
          'qualification' in manifest &&
          manifest.qualification &&
          typeof manifest.qualification === 'object' &&
          'instanceId' in manifest.qualification &&
          manifest.qualification.instanceId !== this.store.instanceId
        )
          continue;
        if (
          !manifest ||
          typeof manifest !== 'object' ||
          !('packages' in manifest) ||
          !Array.isArray(manifest.packages)
        )
          continue;
        if (
          !manifest.packages.some(
            (pkg: unknown) =>
              pkg &&
              typeof pkg === 'object' &&
              'platform' in pkg &&
              'arch' in pkg &&
              pkg.platform === process.platform &&
              pkg.arch === process.arch,
          )
        )
          continue;
        const signed = verifyUpgradeEnvelope(envelope, roots, this.clock.now().getTime());
        requireUpgrade(
          entry.releaseId === signed.manifest.releaseId &&
            entry.manifestDigest === signed.manifestDigest,
          'CATALOG_IDENTITY_MISMATCH',
        );
        if (
          !newer(signed.manifest.releaseId, installed.releaseId) &&
          !(sourceActual && signed.manifest.releaseId === installed.releaseId)
        )
          continue;
        try {
          const actualSchema = this.inspector.schema();
          const path = signed.manifest.upgradePaths.find(
            (p) =>
              p.fromRelease === installed.releaseId &&
              actualSchema >= p.minSchema &&
              actualSchema <= p.maxSchema,
          );
          requireUpgrade(path, 'UPGRADE_PATH_INCOMPATIBLE');
          // Only the fixed, journal-bound additive recipe may cross a global
          // version. Namespace read epochs do not register Drizzle migrations.
          requireUpgrade(
            compatibleGlobalSchemaPath(path, actualSchema),
            'GLOBAL_SCHEMA_MIGRATION_UNQUALIFIED',
          );
          requireUpgrade(
            !this.store.sqlite
              .prepare('SELECT 1 FROM upgrade_online_migrations WHERE read_epoch=2 LIMIT 1')
              .get() ||
              signed.manifest.components.coordinator.dataFormats?.includes(
                'project-name-v2-authority',
              ),
            'TARGET_DATA_FORMAT_INCOMPATIBLE',
          );
          targets.push({
            envelope: signed,
            plan: freezeUpgradePlan(signed, planSource, this.store.appliedBridges()),
            sourceActual,
          });
        } catch (error) {
          if (!(error instanceof UpgradeError)) throw error;
          incompatibleReason = error.code;
        }
      }
      targets.sort((a, b) =>
        newer(a.envelope.manifest.releaseId, b.envelope.manifest.releaseId) ? -1 : 1,
      );
      this.verified = targets[0] ?? null;
      const target = this.verified?.envelope;
      this.projection = {
        state: target ? 'verified' : incompatibleReason ? 'unavailable' : 'no-update',
        observedAt,
        reason: target ? null : incompatibleReason,
        availableRelease: target
          ? {
              releaseId: target.manifest.releaseId,
              targetDigest: target.manifestDigest,
              webRevision: target.manifest.components.web.webRevision,
              webArtifactDigest: target.manifest.components.web.artifactDigest,
              installable: true,
            }
          : null,
      };
    } catch (error) {
      this.projection = {
        state: 'unknown',
        observedAt,
        availableRelease: null,
        reason: error instanceof UpgradeError ? error.code : 'CATALOG_UNAVAILABLE',
      };
    }
  }
}
