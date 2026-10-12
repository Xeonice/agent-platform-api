import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import {
  SANDBOX_PROVIDER_REGISTRY,
  SANDBOX_EXEC_PORT,
  PLATFORM_AGENT_TMUX_SESSION,
  type ConfirmedServiceRelease,
  type ProviderRegistry,
  type SandboxHandle,
  type SandboxExecPort,
  UpgradeSourceActualSchema,
  type UpgradeSourceActual,
} from '@platform/contracts';
import {
  RuntimeOwnerProviderRegistry,
  JOB_COMPLETION_RECEIPTS,
  completedJobHandleDigest,
  type JobCompletionReceipts,
} from '@platform/sandbox';
import { UpgradeStore } from './upgrade-store';
import { verifyUpgradeArtifact } from './verify-upgrade-artifact';
import { canonicalUpgrade, requireUpgrade, upgradeDigest } from './upgrade-trust';
import { env } from '../config/env';
import { UpgradeOnlineMigration } from './upgrade-online-migration';
import { UpgradeSecurity } from '../access-passcode/upgrade-security.service';
import { PasscodeService } from '../access-passcode/passcode.service';
import { SESSION_COOKIE } from '../access-passcode/session-cookie';

type Json = Record<string, unknown>;
export function persistedBinding(value: Json): Json {
  const {
    inFlight: _requests,
    activeWS: _sockets,
    httpByDigest: _http,
    wsByDigest: _ws,
    ...persistent
  } = value;
  return persistent;
}
interface ResourceRow {
  id: string;
  provider: string;
  provider_handle: string;
  provider_state: string | null;
  status: string;
  headless: number;
}
interface ResourceProof {
  sandboxId: string;
  provider: string;
  handleDigest: string;
  runtimeIdentity: string | null;
  status: string;
  lifecycleState: string;
  headless: boolean;
}

export function loopbackOrigin(value: unknown): string {
  requireUpgrade(typeof value === 'string', 'PRIVATE_ORIGIN_REQUIRED');
  const url = new URL(value);
  requireUpgrade(
    url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash,
    'PRIVATE_ORIGIN_REQUIRED',
  );
  return url.origin;
}

/** Live probes are capabilities of the Coordinator, never caller-supplied booleans. */
@Injectable()
export class UpgradeInspector {
  constructor(
    private readonly store: UpgradeStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
    private readonly migrations: UpgradeOnlineMigration,
    private readonly security: UpgradeSecurity,
    private readonly passcodes: PasscodeService,
    @Inject(JOB_COMPLETION_RECEIPTS) private readonly jobCompletions: JobCompletionReceipts,
    @Inject(SANDBOX_EXEC_PORT) private readonly exec: SandboxExecPort,
  ) {}
  get observedAt(): string {
    return this.clock.now().toISOString();
  }
  async entryBinding(): Promise<Json> {
    const origin = loopbackOrigin(process.env.PLATFORM_ENTRY_CONTROL_ORIGIN);
    const key = process.env.PLATFORM_ENTRY_CONTROL_KEY;
    requireUpgrade(key && key.length >= 32, 'ENTRY_CONTROL_KEY_REQUIRED');
    const r = await fetch(origin + '/binding', {
      headers: { 'x-platform-internal-key': key },
      signal: AbortSignal.timeout(2000),
    });
    requireUpgrade(r.ok, 'ENTRY_BINDING_UNAVAILABLE');
    const binding = (await r.json()) as Json;
    requireUpgrade(binding.instanceId === this.store.instanceId, 'ENTRY_INSTANCE_MISMATCH');
    return binding;
  }
  async controlIdentity(origin: unknown): Promise<Json> {
    const base = loopbackOrigin(origin);
    const r = await fetch(base + '/internal/control/identity', {
      headers: {
        'x-platform-internal-key': process.env.PLATFORM_CONTROL_RPC_KEY ?? '',
        'x-platform-instance-id': this.store.instanceId,
      },
      signal: AbortSignal.timeout(2000),
    });
    requireUpgrade(r.ok, 'CANDIDATE_NOT_READY');
    const value = (await r.json()) as Json;
    requireUpgrade(
      value.instanceId === this.store.instanceId && value.role === 'control',
      'CONTROL_IDENTITY_MISMATCH',
    );
    return value;
  }
  async installerIdentity(): Promise<Json> {
    const origin = loopbackOrigin(process.env.PLATFORM_INSTALLER_SUPERVISOR_ORIGIN);
    const key = process.env.PLATFORM_INSTALLER_SUPERVISOR_KEY;
    requireUpgrade(key && key.length >= 32, 'INSTALLER_OBSERVER_REQUIRED');
    const response = await fetch(origin + '/metadata', {
      headers: { 'x-platform-internal-key': key },
      signal: AbortSignal.timeout(1500),
    });
    requireUpgrade(response.ok, 'ACTUAL_INSTALLER_UNKNOWN');
    const identity = (await response.json()) as Json;
    requireUpgrade(
      identity.instanceId === this.store.instanceId &&
        identity.role === 'installer' &&
        typeof identity.startIdentity === 'string' &&
        Number.isSafeInteger(identity.pid) &&
        Number(identity.pid) > 0 &&
        this.clock.now().getTime() - Date.parse(String(identity.observedAt)) <= 5000,
      'ACTUAL_INSTALLER_UNKNOWN',
    );
    return identity;
  }
  async installedProof(release: ConfirmedServiceRelease, binding?: Json): Promise<Json> {
    const actual = binding ?? (await this.entryBinding());
    const api = (actual.weight === 100 ? actual.candidateApi : actual.oldApi) as Json;
    const identity = await this.controlIdentity(api.origin),
      web = await this.webBuild(actual),
      installer = await this.installerIdentity();
    const coor = release.components.coordinator ?? release.components.api;
    const apiMatches =
      api.digest === release.components.api.artifactDigest &&
      identity.artifactDigest === api.digest;
    const coordinatorMatches =
      identity.actualCoordinatorArtifactDigest === coor.artifactDigest &&
      identity.writerFenceValid === true;
    const webMatches =
      (actual.web as Json).digest === release.components.web.artifactDigest &&
      web.webRevision === release.components.web.webRevision;
    const installerMatches =
      installer.artifactDigest === release.components.installer.artifactDigest &&
      installer.inputFingerprint === release.components.installer.inputFingerprint;
    let ownerMatches = !release.components.owner;
    if (release.components.owner) {
      requireUpgrade(
        this.providers instanceof RuntimeOwnerProviderRegistry,
        'ACTUAL_OWNER_UNKNOWN',
      );
      const activeOwnerId = this.providers.activeOwnerId;
      const route = this.providers.installedRoutes().find((r) => r.ownerId === activeOwnerId);
      requireUpgrade(route, 'ACTUAL_OWNER_UNKNOWN');
      const response = await fetch(loopbackOrigin(route.endpoint) + '/runtime/metadata', {
        headers: {
          'x-platform-internal-key': process.env.PLATFORM_COORDINATOR_RPC_KEY ?? '',
          'x-platform-instance-id': this.store.instanceId,
        },
        signal: AbortSignal.timeout(1500),
      });
      requireUpgrade(response.ok, 'ACTUAL_OWNER_UNKNOWN');
      const owner = (await response.json()) as Json;
      ownerMatches =
        owner.instanceId === this.store.instanceId &&
        owner.ownerId === route.ownerId &&
        owner.artifactDigest === release.components.owner.artifactDigest &&
        owner.inputFingerprint === release.components.owner.inputFingerprint;
    }
    return {
      qualified:
        apiMatches &&
        coordinatorMatches &&
        webMatches &&
        installerMatches &&
        ownerMatches &&
        release.schema === this.schema(),
      apiMatches,
      coordinatorMatches,
      webMatches,
      installerMatches,
      ownerMatches,
      instanceId: this.store.instanceId,
      identity,
      installer,
      web,
      observedAt: this.observedAt,
    };
  }
  /** A measured mixed installation is never promoted to a confirmed release.
   * Only installed signed artifacts and a live unique writer may seed a NEW
   * user intent. The last complete release remains the version-chain anchor. */
  async sourceActual(forRecovery = false): Promise<UpgradeSourceActual | null> {
    const source = this.store.confirmed(),
      latest = this.store.latest();
    if (
      !source ||
      !latest ||
      !['deferred', 'failed', 'reverted', 'candidate-rejected', 'activation-confirmed'].includes(
        latest.state,
      ) ||
      (!forRecovery && this.store.recovery()?.state === 'recovering')
    )
      return null;
    const binding = await this.entryBinding();
    // The ordinary confirmed path is read-only live identity probing. Do not
    // rehash an unchanged multi-gigabyte installation on every status poll.
    if ((await this.installedProof(source, binding)).qualified === true) return null;
    requireUpgrade(binding.weight === 0 || binding.weight === 100, 'PARTIAL_ROUTE_UNCONFIRMED');
    const api = (binding.weight === 100 ? binding.candidateApi : binding.oldApi) as Json;
    const identity = await this.controlIdentity(api.origin),
      web = await this.webBuild(binding),
      installer = await this.installerIdentity();
    requireUpgrade(
      identity.writerFenceValid === true &&
        identity.controlOnly === true &&
        identity.noRuntimeSideEffects === true,
      'SOURCE_WRITER_UNCONFIRMED',
    );
    requireUpgrade(
      this.store.sqlite.pragma('quick_check', { simple: true }) === 'ok',
      'SOURCE_DATABASE_UNCONFIRMED',
    );
    requireUpgrade(this.providers instanceof RuntimeOwnerProviderRegistry, 'ACTUAL_OWNER_UNKNOWN');
    const route = this.providers
      .installedRoutes()
      .find((r) => r.ownerId === this.providersActiveOwner());
    requireUpgrade(route, 'ACTUAL_OWNER_UNKNOWN');
    const response = await fetch(loopbackOrigin(route.endpoint) + '/runtime/metadata', {
      headers: {
        'x-platform-internal-key': process.env.PLATFORM_COORDINATOR_RPC_KEY ?? '',
        'x-platform-instance-id': this.store.instanceId,
      },
      signal: AbortSignal.timeout(1500),
    });
    requireUpgrade(response.ok, 'ACTUAL_OWNER_UNKNOWN');
    const owner = (await response.json()) as Json;
    requireUpgrade(
      owner.instanceId === this.store.instanceId && owner.ownerId === route.ownerId,
      'ACTUAL_OWNER_UNKNOWN',
    );
    const installs = this.store.sqlite
      .prepare('SELECT manifest,plan FROM upgrade_attempts ORDER BY generation DESC')
      .all() as { manifest: string; plan: string }[];
    const candidates: { root: string; components: ConfirmedServiceRelease['components'] }[] = [];
    if (process.env.UPGRADE_INITIAL_ARTIFACT_ROOT && process.env.UPGRADE_INITIAL_RELEASE_PATH) {
      const raw = JSON.parse(
        await readFile(process.env.UPGRADE_INITIAL_RELEASE_PATH, 'utf8'),
      ) as Json;
      const initial = (raw.release ?? raw) as ConfirmedServiceRelease;
      candidates.push({
        root: process.env.UPGRADE_INITIAL_ARTIFACT_ROOT,
        components: initial.components,
      });
    }
    for (const install of installs) {
      const manifest = JSON.parse(install.manifest) as {
        manifest: { components: ConfirmedServiceRelease['components'] };
      };
      const plan = JSON.parse(install.plan) as { package: { digest: string } };
      candidates.push({
        root: resolve(
          process.env.UPGRADE_INSTALLER_ROOT ?? '',
          'artifacts',
          plan.package.digest.slice(7),
        ),
        components: manifest.manifest.components,
      });
    }
    const components: ConfirmedServiceRelease['components'] = { ...source.components };
    const facts = {
      api: { digest: api.digest, input: identity.inputFingerprint },
      coordinator: {
        digest: identity.actualCoordinatorArtifactDigest,
        input: identity.actualCoordinatorInputFingerprint,
      },
      web: { digest: (binding.web as Json).digest, revision: web.webRevision },
      installer: { digest: installer.artifactDigest, input: installer.inputFingerprint },
      owner: { digest: owner.artifactDigest, input: owner.inputFingerprint },
    };
    const verified = new Set<string>();
    for (const name of ['api', 'coordinator', 'web', 'installer', 'owner'] as const) {
      const fact = facts[name];
      const match = candidates.find((c) => {
        const part = c.components[name] ?? (name === 'coordinator' ? c.components.api : undefined);
        return (
          part &&
          part.artifactDigest === fact.digest &&
          (!('input' in fact) || fact.input === part.inputFingerprint) &&
          (!('revision' in fact) || ('webRevision' in part && part.webRevision === fact.revision))
        );
      });
      requireUpgrade(match, 'SOURCE_COMPONENT_UNCONFIRMED');
      if (!verified.has(match.root)) {
        await this.verifyArtifact(match.root, match.components);
        verified.add(match.root);
      }
      const part = match.components[name] ?? match.components.api;
      if (name === 'web') components.web = match.components.web;
      else components[name] = part;
    }
    const changed =
      canonicalUpgrade(components) !== canonicalUpgrade(source.components) ||
      this.schema() !== source.schema;
    if (!changed) return null;
    const continuity = await this.continuity(latest.attemptId);
    requireUpgrade(continuity.qualified === true, 'SOURCE_CONTINUITY_UNCONFIRMED');
    const ownerProof = continuity.owner as Json;
    const owners = ownerProof.owners as Json[];
    const protocol = (components.coordinator ?? components.api).protocol;
    requireUpgrade(
      owners.length > 0 &&
        owners.every((o) => {
          const p = o.protocol as Json;
          return Number(p.min) <= protocol.max && Number(p.max) >= protocol.min;
        }),
      'SOURCE_OWNER_PROTOCOL_UNCONFIRMED',
    );
    requireUpgrade(
      canonicalUpgrade(persistedBinding(binding)) ===
        canonicalUpgrade(persistedBinding(await this.entryBinding())),
      'SOURCE_BINDING_CHANGED',
    );
    const measured = {
      schemaVersion: 1,
      qualified: true,
      partial: true,
      instanceId: this.store.instanceId,
      baseConfirmedReleaseId: source.releaseId,
      activationGeneration: source.activationGeneration,
      schema: this.schema(),
      components,
      observedAt: this.observedAt,
    };
    return UpgradeSourceActualSchema.parse({ ...measured, proofDigest: upgradeDigest(measured) });
  }
  private providersActiveOwner(): string {
    requireUpgrade(this.providers instanceof RuntimeOwnerProviderRegistry, 'ACTUAL_OWNER_UNKNOWN');
    return this.providers.activeOwnerId;
  }
  async processObserve(input: Json): Promise<Json> {
    requireUpgrade(
      input.instanceId === this.store.instanceId &&
        typeof input.attemptId === 'string' &&
        typeof input.startIdentity === 'string',
      'PROCESS_SCOPE_MISMATCH',
    );
    const snapshot = this.store.snapshot(input.attemptId);
    const component =
      input.kind === 'api'
        ? snapshot.manifest.components.api
        : input.kind === 'web'
          ? snapshot.manifest.components.web
          : input.kind === 'coordinator'
            ? snapshot.manifest.components.coordinator
            : input.kind === 'owner'
              ? snapshot.manifest.components.owner
              : input.kind === 'installer'
                ? snapshot.manifest.components.installer
                : null;
    requireUpgrade(
      component && input.artifactDigest === component.artifactDigest,
      'PROCESS_ARTIFACT_MISMATCH',
    );
    const origin = loopbackOrigin(input.managementOrigin ?? input.origin);
    const path =
      input.kind === 'api'
        ? '/internal/control/identity'
        : input.kind === 'web'
          ? '/web-process'
          : input.kind === 'owner'
            ? '/runtime/metadata'
            : input.kind === 'installer'
              ? '/metadata'
              : '/internal/coordinator/identity';
    const key =
      input.kind === 'api'
        ? process.env.PLATFORM_CONTROL_RPC_KEY
        : input.kind === 'owner'
          ? process.env.PLATFORM_COORDINATOR_RPC_KEY
          : process.env.PLATFORM_CONTROLLER_RPC_KEY;
    try {
      const response = await fetch(origin + path, {
        headers: {
          'x-platform-internal-key': key ?? '',
          'x-platform-instance-id': this.store.instanceId,
        },
        signal: AbortSignal.timeout(1500),
      });
      requireUpgrade(response.ok, 'PROCESS_OBSERVATION_UNKNOWN');
      const observed = (await response.json()) as Json;
      requireUpgrade(
        observed.instanceId === this.store.instanceId &&
          observed.startIdentity === input.startIdentity &&
          observed.artifactDigest === component.artifactDigest &&
          Number.isSafeInteger(observed.pid) &&
          Number(observed.pid) > 0 &&
          (input.pid == null || observed.pid === input.pid),
        'PROCESS_IDENTITY_UNCONFIRMED',
      );
      return {
        qualified: true,
        pid: observed.pid,
        startIdentity: observed.startIdentity,
        artifactDigest: observed.artifactDigest,
        observedAt: this.observedAt,
      };
    } catch {
      // A missing heartbeat, pid:null or connection refusal is not proof that the
      // original accepted spawn did not happen. Supervisor retains the intent.
      return {
        qualified: false,
        definitelyAbsent: false,
        startIdentity: input.startIdentity,
        artifactDigest: component.artifactDigest,
        observedAt: this.observedAt,
      };
    }
  }
  async webBuild(binding: Json): Promise<{ webRevision: string; releaseId: string | null }> {
    const web = binding.web as Json | undefined;
    requireUpgrade(web && typeof web.origin === 'string', 'WEB_BINDING_UNKNOWN');
    const r = await fetch(loopbackOrigin(web.origin) + '/web-build', {
      signal: AbortSignal.timeout(2000),
    });
    requireUpgrade(r.ok, 'WEB_BUILD_UNAVAILABLE');
    const actual = (await r.json()) as Json;
    requireUpgrade(
      typeof actual.webRevision === 'string' &&
        /^[a-f0-9]{40}$/.test(actual.webRevision) &&
        (actual.releaseId === null || typeof actual.releaseId === 'string'),
      'WEB_BUILD_IDENTITY_UNKNOWN',
    );
    return { webRevision: actual.webRevision, releaseId: actual.releaseId as string | null };
  }
  async verifyArtifact(
    root: string,
    expected: ConfirmedServiceRelease['components'],
  ): Promise<void> {
    await verifyUpgradeArtifact(root, expected);
  }
  schema(): number {
    return this.migrations.schema();
  }
  async bootstrapProof(release: ConfirmedServiceRelease, artifactRoot: string): Promise<void> {
    await this.verifyArtifact(artifactRoot, release.components);
    const binding = await this.entryBinding(),
      web = binding.web as Json,
      api = binding.oldApi as Json;
    const identity = await this.controlIdentity(api.origin),
      build = await this.webBuild(binding);
    requireUpgrade(
      binding.weight === 0 &&
        api.digest === release.components.api.artifactDigest &&
        web.digest === release.components.web.artifactDigest &&
        identity.artifactDigest === api.digest &&
        build.webRevision === release.components.web.webRevision &&
        release.schema === this.schema(),
      'INITIAL_ACTIVATION_UNCONFIRMED',
    );
    requireUpgrade(
      (await this.installedProof(release, binding)).qualified === true,
      'INITIAL_COMPONENTS_UNCONFIRMED',
    );
  }
  private rows(): ResourceRow[] {
    return this.store.sqlite
      .prepare(
        "SELECT id,provider,provider_handle,provider_state,status,headless FROM sandboxes WHERE status IN ('running','idle','starting','creating','stopping')",
      )
      .all() as ResourceRow[];
  }
  private handle(row: ResourceRow): SandboxHandle {
    return {
      provider: row.provider,
      providerSandboxId: row.provider_handle,
      ...(row.provider_state
        ? { providerState: JSON.parse(row.provider_state) as Record<string, unknown> }
        : {}),
    };
  }
  async resources(): Promise<ResourceProof[]> {
    return Promise.all(
      this.rows().map(async (row) => {
        if (!row.provider_handle)
          return {
            sandboxId: row.id,
            provider: row.provider,
            handleDigest: upgradeDigest(null),
            runtimeIdentity: null,
            status: row.status,
            lifecycleState: 'unknown',
            headless: row.headless === 1,
          };
        try {
          const inspected = await this.providers.get(row.provider).inspect(this.handle(row));
          const raw = inspected.raw as Json | undefined;
          return {
            sandboxId: row.id,
            provider: row.provider,
            handleDigest: upgradeDigest({ provider: row.provider, handle: row.provider_handle }),
            runtimeIdentity: typeof raw?.runtimeIdentity === 'string' ? raw.runtimeIdentity : null,
            status: row.status,
            lifecycleState: inspected.lifecycleState,
            headless: row.headless === 1,
          };
        } catch {
          return {
            sandboxId: row.id,
            provider: row.provider,
            handleDigest: upgradeDigest({ provider: row.provider, handle: row.provider_handle }),
            runtimeIdentity: null,
            status: row.status,
            lifecycleState: 'unknown',
            headless: row.headless === 1,
          };
        }
      }),
    );
  }
  async capture(): Promise<Json> {
    const tables = this.store.sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[];
    const columns = Object.fromEntries(
      tables.map((t) => [
        t.name,
        this.store.sqlite.prepare('PRAGMA table_info(' + JSON.stringify(t.name) + ')').all(),
      ]),
    );
    const release = this.store.confirmed();
    const coordinator = {
      origin: loopbackOrigin(`http://${env.host}:${env.port}`),
      startIdentity: process.env.PLATFORM_PROCESS_START_IDENTITY ?? null,
      artifactDigest: process.env.PLATFORM_ARTIFACT_DIGEST ?? null,
      inputFingerprint:
        process.env.PLATFORM_COORDINATOR_ACTUAL_INPUT_FINGERPRINT ??
        (release?.components.coordinator ?? release?.components.api)?.inputFingerprint ??
        null,
      generation: Number(process.env.COORDINATOR_GENERATION ?? 0),
    };
    const ownerBinding =
      this.providers instanceof RuntimeOwnerProviderRegistry
        ? {
            instanceId: this.store.instanceId,
            activeOwnerId: this.providers.activeOwnerId,
            owners: this.providers.installedRoutes(),
          }
        : null;
    return {
      resources: await this.resources(),
      tasks: this.store.sqlite
        .prepare(
          "SELECT id,sandbox_id,job_handle,last_seq,stdout_bytes,status,cancel_requested_at,started_at,timeout_ms FROM agent_tasks WHERE status='running'",
        )
        .all(),
      automations: this.store.sqlite
        .prepare(
          'SELECT id,enabled,schedule_kind,schedule_config,timezone,next_trigger_at FROM automations WHERE enabled=1',
        )
        .all(),
      transitionsAfter: (
        this.store.sqlite
          .prepare('SELECT coalesce(max(rowid),0) AS n FROM sandbox_state_transitions')
          .get() as { n: number }
      ).n,
      coordinatorGeneration: Number(process.env.COORDINATOR_GENERATION ?? 0),
      coordinator,
      ownerBinding,
      columns,
      terminals: this.store.sqlite
        .prepare(
          "SELECT t.terminal_identity,t.sandbox_id,t.kind,t.private_session_id,t.runtime_identity FROM terminal_bookmarks t JOIN sandboxes s ON s.id=t.sandbox_id WHERE t.runtime_identity IS NOT NULL AND t.close_requested_at IS NULL AND s.status IN ('running','idle','starting')",
        )
        .all(),
      auditAfter: (
        this.store.sqlite.prepare('SELECT coalesce(max(seq),0) n FROM audit_events').get() as {
          n: number;
        }
      ).n,
      authContinuityFingerprint: this.authFingerprint(),
      observedAt: this.observedAt,
    };
  }
  private authFingerprint(): string {
    return upgradeDigest({
      upgrade: this.security.continuityFingerprint(this.store.instanceId),
      access: this.passcodes.issueSessionToken(0),
    });
  }
  async authenticationContinuity(id: string, fence: number, origin: unknown): Promise<boolean> {
    this.store.assertFence(id, fence);
    const row = this.store.sqlite
      .prepare('SELECT snapshot FROM upgrade_continuity_baselines WHERE attempt_id=?')
      .get(id) as { snapshot: string } | undefined;
    if (
      !row ||
      (JSON.parse(row.snapshot) as Json).authContinuityFingerprint !== this.authFingerprint()
    )
      return false;
    const challenge = this.security.continuityChallenge(this.store.instanceId);
    const cookie =
      challenge.cookie +
      '; ' +
      SESSION_COOKIE +
      '=' +
      encodeURIComponent(this.passcodes.issueSessionToken(this.clock.now().getTime()));
    try {
      const response = await fetch(loopbackOrigin(origin) + '/api/system/upgrade/status', {
        headers: { cookie },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return false;
      const actual = (await response.json()) as Json;
      return (
        actual.instanceId === this.store.instanceId &&
        actual.userScope === challenge.userScope &&
        (actual.capabilities as Json)?.canUpgradeInstance === true
      );
    } catch {
      return false;
    }
  }
  recordBaseline(id: string, snapshot: Json): void {
    this.store.sqlite
      .prepare('INSERT OR IGNORE INTO upgrade_continuity_baselines VALUES(?,?,?,?)')
      .run(id, canonicalUpgrade(snapshot), upgradeDigest(snapshot), this.clock.now().getTime());
  }
  async ownerEvidence(): Promise<Json> {
    requireUpgrade(
      this.providers instanceof RuntimeOwnerProviderRegistry,
      'OWNER_REGISTRY_REQUIRED',
    );
    const routes = this.providers.installedRoutes(),
      activeOwnerId = this.providers.activeOwnerId;
    const owners = await Promise.all(
      routes.map(async (route) => {
        const r = await fetch(loopbackOrigin(route.endpoint) + '/runtime/continuity', {
          headers: {
            'x-platform-internal-key': process.env.PLATFORM_COORDINATOR_RPC_KEY ?? '',
            'x-platform-instance-id': this.store.instanceId,
          },
          signal: AbortSignal.timeout(2000),
        });
        requireUpgrade(r.ok, 'OWNER_AUDIT_UNKNOWN');
        const value = (await r.json()) as Json;
        requireUpgrade(
          value.instanceId === this.store.instanceId &&
            value.ownerId === route.ownerId &&
            value.observedAt &&
            this.clock.now().getTime() - Date.parse(String(value.observedAt)) <= 5000,
          'OWNER_AUDIT_UNKNOWN',
        );
        const metadataResponse = await fetch(loopbackOrigin(route.endpoint) + '/runtime/metadata', {
          headers: {
            'x-platform-internal-key': process.env.PLATFORM_COORDINATOR_RPC_KEY ?? '',
            'x-platform-instance-id': this.store.instanceId,
          },
          signal: AbortSignal.timeout(1500),
        });
        requireUpgrade(metadataResponse.ok, 'OWNER_PROTOCOL_UNKNOWN');
        const metadata = (await metadataResponse.json()) as Json;
        requireUpgrade(
          metadata.ownerId === route.ownerId && metadata.instanceId === this.store.instanceId,
          'OWNER_IDENTITY_CHANGED',
        );
        return {
          ...value,
          protocol:
            typeof metadata.protocol === 'number'
              ? { min: metadata.protocol, max: metadata.protocol }
              : metadata.protocol,
          artifactDigest: metadata.artifactDigest,
          inputFingerprint: metadata.inputFingerprint,
        } as Json;
      }),
    );
    const active = owners.find((o) => o.ownerId === activeOwnerId);
    requireUpgrade(active, 'ACTIVE_OWNER_AUDIT_UNKNOWN');
    return {
      instanceId: this.store.instanceId,
      activeOwnerId,
      owners,
      operations: owners.flatMap((o) => (Array.isArray(o.operations) ? o.operations : [])),
      lease: active.lease,
      observedAt: this.observedAt,
    };
  }
  async continuity(id: string, fence?: number): Promise<Json> {
    if (fence !== undefined) this.store.assertFence(id, fence);
    else
      requireUpgrade(
        this.store.latest()?.attemptId === id &&
          ['deferred', 'failed', 'reverted', 'candidate-rejected', 'activation-confirmed'].includes(
            this.store.attempt(id).state,
          ),
        'REPAIR_SOURCE_NOT_TERMINAL',
      );
    const record = this.store.sqlite
      .prepare('SELECT snapshot,digest FROM upgrade_continuity_baselines WHERE attempt_id=?')
      .get(id) as { snapshot: string; digest: string } | undefined;
    requireUpgrade(record, 'CONTINUITY_BASELINE_MISSING');
    const baseline = JSON.parse(record.snapshot) as Json;
    requireUpgrade(upgradeDigest(baseline) === record.digest, 'CONTINUITY_BASELINE_CORRUPT');
    const current = await this.resources(),
      reasons: string[] = [];
    for (const original of baseline.resources as ResourceProof[]) {
      const row = current.find((v) => v.sandboxId === original.sandboxId);
      const intentional = this.store.sqlite
        .prepare(
          "SELECT 1 FROM sandbox_state_transitions WHERE sandbox_id=? AND rowid>? AND triggered_by='user' AND to_status IN ('stopping','destroying','destroyed')",
        )
        .get(original.sandboxId, baseline.transitionsAfter);
      if (intentional) continue;
      if (
        !original.runtimeIdentity ||
        !row?.runtimeIdentity ||
        original.runtimeIdentity !== row.runtimeIdentity ||
        original.handleDigest !== row.handleDigest ||
        row.lifecycleState !== 'instance_running'
      )
        reasons.push('ORIGINAL_RUNTIME_UNCONFIRMED');
    }
    for (const original of baseline.tasks as Json[]) {
      const currentTask = this.store.sqlite
        .prepare(
          'SELECT job_handle,cursor,exit_code,last_seq,stdout_bytes,status,cancel_requested_at FROM agent_tasks WHERE id=?',
        )
        .get(original.id) as Json | undefined;
      if (
        !currentTask ||
        currentTask.job_handle !== original.job_handle ||
        Number(currentTask.last_seq) < Number(original.last_seq) ||
        Number(currentTask.stdout_bytes) < Number(original.stdout_bytes)
      )
        reasons.push('ORIGINAL_TASK_IDENTITY_OR_CURSOR_CHANGED');
      // A real business cancel or genuine completed job is separately auditable;
      // database status alone never establishes the original process continuity.
      if (currentTask && currentTask.status !== 'running' && !currentTask.cancel_requested_at) {
        const completion = await this.jobCompletions.find(String(original.id));
        let originalHandle: { provider: string; jobId: string } | null = null;
        try {
          originalHandle = JSON.parse(String(original.job_handle)) as {
            provider: string;
            jobId: string;
          };
        } catch {
          /* Unknown original handles cannot prove an exit. */
        }
        const kindMatches =
          completion &&
          (completion.exitKind === 'timeout'
            ? currentTask.status === 'timed_out'
            : completion.exitKind === 'cancelled'
              ? currentTask.status === 'killed' && Boolean(currentTask.cancel_requested_at)
              : ['succeeded', 'failed'].includes(String(currentTask.status)));
        if (
          !completion ||
          !kindMatches ||
          !originalHandle ||
          completion.sandboxId !== original.sandbox_id ||
          completion.jobHandleDigest !== completedJobHandleDigest(originalHandle) ||
          completion.lastSeq < Number(original.last_seq) ||
          completion.lastSeq !== currentTask.last_seq ||
          completion.cursor !== currentTask.cursor ||
          completion.exitCode !== currentTask.exit_code ||
          completion.observedAt.getTime() < Date.parse(String(baseline.observedAt)) ||
          completion.observedAt.getTime() > this.clock.now().getTime()
        )
          reasons.push('NATURAL_JOB_EXIT_NEEDS_OWNER_RECEIPT');
      }
    }
    for (const original of baseline.automations as Json[]) {
      const row = this.store.sqlite
        .prepare(
          'SELECT enabled,schedule_kind,schedule_config,timezone FROM automations WHERE id=?',
        )
        .get(original.id) as Json | undefined;
      const audits = this.store.sqlite
        .prepare(
          "SELECT seq,type,at,detail FROM audit_events WHERE seq>? AND subject_type='automation' AND subject_id=? AND actor='user' AND outcome='ok' AND type IN ('automation.updated','automation.deleted','automation.enabled','automation.disabled') ORDER BY seq",
        )
        .all(baseline.auditAfter ?? 0, original.id) as Json[];
      const changedFields = ['schedule_kind', 'schedule_config', 'timezone'].filter(
        (key) => row?.[key] !== original[key],
      );
      const userFields = new Set<string>();
      for (const audit of audits)
        if (audit.type === 'automation.updated') {
          try {
            const detail = JSON.parse(String(audit.detail)) as Json;
            if (Array.isArray(detail.fieldNames))
              for (const field of detail.fieldNames) userFields.add(String(field));
          } catch {
            /* Unknown audit is not a business authorization. */
          }
        }
      const mapped: Record<string, string> = {
        schedule_kind: 'scheduleKind',
        schedule_config: 'scheduleConfig',
        timezone: 'timezone',
      };
      const userChange = !row
        ? audits.some((a) => a.type === 'automation.deleted')
        : changedFields.every((f) => userFields.has(mapped[f])) &&
          (row.enabled === original.enabled ||
            audits.some(
              (a) => a.type === (row.enabled === 1 ? 'automation.enabled' : 'automation.disabled'),
            ));
      if (
        !userChange &&
        (!row ||
          row.enabled !== original.enabled ||
          row.schedule_kind !== original.schedule_kind ||
          row.schedule_config !== original.schedule_config ||
          row.timezone !== original.timezone)
      )
        reasons.push('AUTOMATION_CHANGED_DURING_UPGRADE');
    }
    for (const terminal of (Array.isArray(baseline.terminals)
      ? baseline.terminals
      : []) as Json[]) {
      const bookmark = this.store.sqlite
        .prepare(
          'SELECT close_requested_at FROM terminal_bookmarks WHERE terminal_identity=? AND sandbox_id=?',
        )
        .get(terminal.terminal_identity, terminal.sandbox_id) as
        { close_requested_at: number | null } | undefined;
      if (bookmark?.close_requested_at != null) continue;
      const intentionalStop = this.store.sqlite
        .prepare(
          "SELECT 1 FROM sandbox_state_transitions WHERE sandbox_id=? AND rowid>? AND triggered_by='user' AND to_status IN ('stopping','destroying','destroyed')",
        )
        .get(terminal.sandbox_id, baseline.transitionsAfter);
      if (intentionalStop) continue;
      const resource = current.find((r) => r.sandboxId === terminal.sandbox_id);
      if (!resource?.runtimeIdentity) {
        reasons.push('ORIGINAL_TERMINAL_UNCONFIRMED');
        continue;
      }
      try {
        const execute = await this.exec.execFor(String(terminal.sandbox_id));
        const session =
          terminal.kind === 'agent'
            ? PLATFORM_AGENT_TMUX_SESSION
            : 'platform-shell-' + String(terminal.private_session_id);
        const proof = await execute(
          [
            'tmux',
            '-u',
            'display-message',
            '-p',
            '-t',
            session,
            '#{pid}:#{session_id}:#{session_created}',
          ],
          { timeoutMs: 2000 },
        );
        if (
          proof.exitCode !== 0 ||
          !/^\d+:\$\d+:\d+\s*$/.test(proof.stdout) ||
          String(terminal.runtime_identity) !==
            resource.runtimeIdentity + '/tmux:' + proof.stdout.trim()
        )
          reasons.push('ORIGINAL_TERMINAL_IDENTITY_CHANGED');
      } catch {
        reasons.push('ORIGINAL_TERMINAL_UNCONFIRMED');
      }
    }
    let owner: Json | null = null;
    try {
      owner = await this.ownerEvidence();
    } catch {
      reasons.push('OWNER_AUDIT_UNKNOWN');
    }
    if (fence !== undefined) this.store.assertFence(id, fence);
    return {
      qualified: reasons.length === 0,
      instanceId: this.store.instanceId,
      attemptId: id,
      fence,
      baselineDigest: record.digest,
      resources: current,
      owner,
      reasons: [...new Set(reasons)],
      observedAt: this.observedAt,
    };
  }
  async validateSwitch(id: string, fence: number, input: Json): Promise<Json> {
    this.store.assertFence(id, fence);
    const snapshot = this.store.snapshot(id);
    requireUpgrade(
      input.manifestDigest === snapshot.signedManifest.manifestDigest,
      'UPGRADE_TARGET_CHANGED',
    );
    const actual = await this.entryBinding();
    if (input.actual)
      requireUpgrade(
        canonicalUpgrade(persistedBinding(input.actual as Json)) ===
          canonicalUpgrade(persistedBinding(actual)),
        'ENTRY_BINDING_CHANGED',
      );
    const candidate = input.candidate as Json | undefined;
    const api =
      candidate ?? ((actual.weight === 100 ? actual.candidateApi : actual.oldApi) as Json);
    const identity = await this.controlIdentity(api.origin),
      continuity = await this.continuity(id, fence);
    const component = snapshot.manifest.components.api;
    const controlOnly = identity.controlOnly === true && identity.noRuntimeSideEffects === true;
    const authContinuity = await this.authenticationContinuity(id, fence, api.origin);
    const originalResourceAddressable = continuity.qualified === true;
    const artifactMatches =
      identity.artifactDigest === component.artifactDigest &&
      (candidate
        ? candidate.artifactDigest === component.artifactDigest &&
          identity.startIdentity === candidate.startIdentity
        : api.digest === component.artifactDigest);
    const businessMatches =
      identity.actualCoordinatorArtifactDigest ===
        snapshot.manifest.components.coordinator.artifactDigest &&
      identity.writerFenceValid === true;
    const web = await this.webBuild(actual);
    const webMatches =
      (actual.web as Json).digest === snapshot.manifest.components.web.artifactDigest &&
      web.webRevision === snapshot.manifest.components.web.webRevision;
    this.store.assertFence(id, fence);
    const base = this.store.sqlite
      .prepare('SELECT snapshot FROM upgrade_continuity_baselines WHERE attempt_id=?')
      .get(id) as { snapshot: string };
    const baseGeneration = (JSON.parse(base.snapshot) as Json).coordinatorGeneration;
    const baselineSamples = (
      this.store.sqlite
        .prepare(
          'SELECT count(*) n FROM upgrade_observations WHERE attempt_id=? AND weight=0 AND success=1 AND coordinator_generation=?',
        )
        .get(id, baseGeneration) as { n: number }
    ).n;
    return {
      qualified:
        artifactMatches &&
        controlOnly &&
        authContinuity &&
        originalResourceAddressable &&
        baselineSamples >= snapshot.plan.policy.minRequests &&
        (candidate ? true : businessMatches && webMatches),
      controlOnly,
      noRuntimeSideEffects: controlOnly,
      authContinuity,
      originalResourceAddressable,
      businessMatches,
      webMatches,
      baselineSamples,
      instanceId: this.store.instanceId,
      attemptId: id,
      fence,
      observedAt: this.observedAt,
      identity,
      web,
    };
  }
}
