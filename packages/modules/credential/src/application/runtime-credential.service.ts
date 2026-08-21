import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  CLOCK,
  EVENT_BUS,
  ID_GENERATOR,
  UNIT_OF_WORK,
  asCredentialId,
  asSandboxId,
  shiftMs,
} from '@platform/shared-kernel';
import type { Clock, EventBus, IdGenerator, UnitOfWork } from '@platform/shared-kernel';
import {
  CredentialPreparationError,
  RUNTIME_SETTINGS_READER,
  RUNTIME_SETTINGS_WRITER,
} from '@platform/contracts';
import type {
  CredentialStatus,
  RuntimeSettingsReader,
  RuntimeSettingsWriter,
} from '@platform/contracts';
import { Credential } from '../domain/entities/credential.entity';
import { CredentialSandboxBinding } from '../domain/entities/credential-sandbox-binding.entity';
import { CredentialInjected } from '../domain/events/credential-events';
import { CREDENTIAL_REPOSITORY } from '../domain/repositories/credential.repository';
import type { CredentialRepository } from '../domain/repositories/credential.repository';
import { CREDENTIAL_SANDBOX_BINDING_REPOSITORY } from '../domain/repositories/credential-sandbox-binding.repository';
import type { CredentialSandboxBindingRepository } from '../domain/repositories/credential-sandbox-binding.repository';
import { CRYPTO_SERVICE } from '../domain/ports/crypto.port';
import type { CryptoService } from '../domain/ports/crypto.port';
import { RUNTIME_CREDENTIAL_MATERIALIZER } from '../domain/ports/runtime-credential-materializer.port';
import type {
  MaterializeRuntimeInput,
  MaterializedRefreshCredential,
  MaterializedRuntimeCredential,
  RuntimeCredentialMaterializer,
  RuntimeSecretPayload,
} from '../domain/ports/runtime-credential-materializer.port';
import { CredentialSelectionService } from '../domain/services/credential-selection.domain-service';
import { modeForRuntimeMethod } from '../domain/value-objects/obtained-via.vo';
import type { RuntimeAuthMethod, RuntimeMode } from '../domain/value-objects/obtained-via.vo';
import { SecretMaterial } from '../domain/value-objects/secret-material.vo';
import { MaskedIdentifier } from '../domain/value-objects/masked-identifier.vo';

/** Days-before-expiry that flips the read-model to `expiring` (I-CRD-7). */
const EXPIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Consecutive refresh failures after which a runtime credential is presented as expired. */
const REFRESH_FAILURE_LIMIT = 3;

export interface StoreRuntimeCredentialInput {
  runtimeId: string;
  obtainedVia: RuntimeAuthMethod;
  maskedIdentifier: string;
  payload: RuntimeSecretPayload;
  expiresAt?: Date | null;
}

export interface RuntimeCredentialView {
  credentialStatus: CredentialStatus;
  credentialId?: string;
  maskedIdentifier?: string;
  expiresAt?: string;
}

/**
 * Per-mode summary for the P21-3 §3 parallel credential cards. One entry per
 * CONFIGURED mode; masked only (never plaintext). `status` collapses the read-model
 * `active` → `ok` (the card badge vocabulary).
 */
export interface RuntimeCredentialSummaryData {
  credentialId: string;
  mode: RuntimeMode;
  maskedIdentifier: string;
  status: 'ok' | 'expiring' | 'expired';
  expiresAt?: string;
  lastUsedAt?: string;
}

export interface RuntimeRefreshDue {
  credentialId: string;
  runtimeId: string;
}

/**
 * Runtime half of the credential Vault (05 §4, 23 §8). Store/select/materialize/
 * revoke/refresh for `kind='runtime'` credentials + the injection ledger. Exported
 * so the runtime context drives it WITHOUT touching the credential repo directly;
 * the cross-context `runtime_settings` first-config write happens in the SAME tx via
 * the injected `RUNTIME_SETTINGS_WRITER` (R-1 bounded exception ②).
 */
@Injectable()
export class RuntimeCredentialService {
  constructor(
    @Inject(CREDENTIAL_REPOSITORY) private readonly repo: CredentialRepository,
    @Inject(CREDENTIAL_SANDBOX_BINDING_REPOSITORY)
    private readonly bindings: CredentialSandboxBindingRepository,
    @Inject(CRYPTO_SERVICE) private readonly crypto: CryptoService,
    @Inject(RUNTIME_CREDENTIAL_MATERIALIZER)
    private readonly materializer: RuntimeCredentialMaterializer,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Optional()
    @Inject(RUNTIME_SETTINGS_WRITER)
    private readonly settingsWriter?: RuntimeSettingsWriter,
    @Optional()
    @Inject(RUNTIME_SETTINGS_READER)
    private readonly settingsReader?: RuntimeSettingsReader,
  ) {}

  /**
   * Collect the runtime credential (encrypt the payload OUTSIDE the tx), then in ONE
   * UoW: revoke any same-(runtime,mode) active credential (I-CRD-5), insert the new
   * one, and — first-config — upsert `runtime_settings` to this mode (R-1 ②).
   */
  async storeRuntimeCredential(
    input: StoreRuntimeCredentialInput,
  ): Promise<{ maskedIdentifier: string }> {
    const mode = modeForRuntimeMethod(input.obtainedVia);
    const secret = SecretMaterial.fromUtf8(JSON.stringify(input.payload));
    try {
      const encrypted = await this.crypto.encrypt(secret); // async, outside the tx
      const now = this.clock.now();
      const id = asCredentialId(this.ids.next());
      const cred = Credential.createRuntime({
        id,
        runtimeId: input.runtimeId,
        obtainedVia: input.obtainedVia,
        masked: MaskedIdentifier.rehydrate(input.maskedIdentifier),
        secret: encrypted,
        now,
        expiresAt: input.expiresAt ?? null,
      });
      const existing = (await this.repo.listByRuntime(input.runtimeId, false)).find(
        (c) => c.mode === mode && !c.isRevoked(),
      );
      // I-RTS-3: `active_auth_method` is seeded ONLY on FIRST config (no settings row
      // yet). A re-store / refresh of a credential must NOT silently flip the effective
      // mode back — the ONLY switch entry point is `PUT /auth-mode` (I-RTS-2, with 409).
      // `activeAuthMethod` returns null iff the runtime has no settings row (the port
      // contract), so a non-null answer means "already configured → leave it alone".
      const alreadyConfigured =
        this.settingsReader !== undefined &&
        (await this.settingsReader.activeAuthMethod(input.runtimeId)) !== null;
      this.uow.run((tx) => {
        if (existing) this.repo.revokeAndEraseSync(tx, existing.id, now);
        this.repo.saveSync(tx, cred);
        // First-config only: seed the effective mode to this credential's mode — SAME
        // tx (R-1 ②). Once a row exists we never re-write it here (I-RTS-3).
        if (!alreadyConfigured) this.settingsWriter?.saveSync(tx, input.runtimeId, mode, now);
        this.events.publishInTx(tx, cred.pullEvents());
      });
      return { maskedIdentifier: input.maskedIdentifier };
    } finally {
      secret.zeroize();
    }
  }

  /**
   * INJECTION path (facade `prepareRuntimeCredential`): select + materialize the ACTIVE
   * runtime credential. The result is a `MaterializedRuntimeCredential`, which has NO
   * `authFile` — the injection path cannot reach the real `refresh_token` (I-CRD-9,
   * 裁决 D-18). This is not the refresh path: see `prepareForRefresh`.
   */
  async prepareActive(
    runtimeId: string,
    activeMode: RuntimeMode,
  ): Promise<MaterializedRuntimeCredential> {
    const candidates = await this.repo.listByRuntime(runtimeId, false);
    const id = CredentialSelectionService.forRuntime(runtimeId, activeMode, candidates);
    if (!id) {
      throw new CredentialPreparationError(
        'NO_CREDENTIAL',
        `no active credential for ${runtimeId}`,
      );
    }
    const cred = await this.requireRuntimeCredential(
      id as string,
      candidates.find((c) => c.id === id),
    );
    const out = await this.materializer.materializeForInjection(this.materializeInputFor(cred));
    this.touchLastUsed(cred);
    return out;
  }

  /**
   * REFRESH path (facade `prepareForRefresh`, 05 §5.1) — the ONLY out-口 that carries
   * the complete auth file with the real `refresh_token`. Its only legitimate caller is
   * the refresh scanner, which seeds a throw-away helper HOME so the CLI refreshes
   * itself. Keyed by `credentialId` because the scanner already picked the row.
   */
  async prepareForRefresh(credentialId: string): Promise<MaterializedRefreshCredential> {
    const cred = await this.requireRuntimeCredential(credentialId);
    const out = await this.materializer.materializeForRefresh(this.materializeInputFor(cred));
    this.touchLastUsed(cred);
    return out;
  }

  /** Load (or accept a prefetched) `kind='runtime'` credential row, or reject. */
  private async requireRuntimeCredential(
    credentialId: string,
    prefetched?: Credential,
  ): Promise<Credential> {
    const cred = prefetched ?? (await this.repo.findById(asCredentialId(credentialId)));
    if (!cred || cred.kind !== 'runtime') {
      throw new CredentialPreparationError(
        'NO_CREDENTIAL',
        `runtime credential ${credentialId} not found`,
      );
    }
    return cred;
  }

  private materializeInputFor(cred: Credential): MaterializeRuntimeInput {
    return {
      runtimeId: cred.runtimeId ?? '',
      obtainedVia: cred.obtainedVia as RuntimeAuthMethod,
      maskedIdentifier: cred.masked.toString(),
      issuedAt: cred.issuedAt,
      expiresAt: cred.expiresAt,
      secret: cred.assertUsable(),
    };
  }

  private touchLastUsed(cred: Credential): void {
    try {
      this.uow.run((tx) => this.repo.touchLastUsedSync(tx, cred.id, this.clock.now()));
    } catch {
      /* best-effort */
    }
  }

  /** Read-model for `GET /api/runtimes` (27 §4) — the ACTIVE credential's status. */
  async view(runtimeId: string, activeMode: RuntimeMode | null): Promise<RuntimeCredentialView> {
    if (!activeMode) return { credentialStatus: 'none' };
    const candidates = await this.repo.listByRuntime(runtimeId, false);
    const id = CredentialSelectionService.forRuntime(runtimeId, activeMode, candidates);
    const cred = id ? candidates.find((c) => c.id === id) : undefined;
    if (!cred) return { credentialStatus: 'none' };
    return {
      credentialStatus: this.deriveStatus(cred, this.clock.now()),
      credentialId: cred.id as string,
      maskedIdentifier: cred.masked.toString(),
      expiresAt: cred.expiresAt ? cred.expiresAt.toISOString() : undefined,
    };
  }

  /**
   * Per-mode summaries for `GET /api/runtimes` cards (P21-3 §3). Lists ALL non-revoked
   * credentials of the runtime and, for EACH configured mode (`account`/`api-key`),
   * emits the active one (I-CRD-5 ⇒ at most one per mode) with its own `credentialId`
   * (the `DELETE .../credentials/:credentialId` target). Unconfigured modes are absent.
   */
  async listSummaries(runtimeId: string): Promise<RuntimeCredentialSummaryData[]> {
    const candidates = await this.repo.listByRuntime(runtimeId, false);
    const now = this.clock.now();
    const out: RuntimeCredentialSummaryData[] = [];
    for (const mode of ['account', 'api-key'] as const) {
      const id = CredentialSelectionService.forRuntime(runtimeId, mode, candidates);
      if (!id) continue;
      const cred = candidates.find((c) => c.id === id);
      if (!cred) continue;
      const derived = this.deriveStatus(cred, now);
      out.push({
        credentialId: cred.id as string,
        mode,
        maskedIdentifier: cred.masked.toString(),
        status: derived === 'active' ? 'ok' : derived === 'expiring' ? 'expiring' : 'expired',
        expiresAt: cred.expiresAt ? cred.expiresAt.toISOString() : undefined,
        lastUsedAt: cred.lastUsedAt ? cred.lastUsedAt.toISOString() : undefined,
      });
    }
    return out;
  }

  private deriveStatus(cred: Credential, now: Date): CredentialStatus {
    if (cred.refreshFailures >= REFRESH_FAILURE_LIMIT) return 'expired';
    if (!cred.expiresAt) return 'active';
    const remaining = cred.expiresAt.getTime() - now.getTime();
    if (remaining <= 0) return 'expired';
    if (remaining < EXPIRING_WINDOW_MS) return 'expiring';
    return 'active';
  }

  /** Revoke a runtime credential (DELETE endpoint). Publishes `CredentialRevoked`. */
  async revoke(runtimeId: string, credentialId: string): Promise<void> {
    const cred = await this.repo.findById(asCredentialId(credentialId));
    if (!cred || cred.kind !== 'runtime' || cred.runtimeId !== runtimeId) {
      throw new NotFoundException(`runtime credential ${credentialId} not found for ${runtimeId}`);
    }
    if (cred.isRevoked()) return; // idempotent
    const now = this.clock.now();
    cred.revoke(now);
    this.uow.run((tx) => {
      this.repo.revokeAndEraseSync(tx, cred.id, now);
      this.events.publishInTx(tx, cred.pullEvents());
    });
  }

  /** Record an injection into a sandbox (facade `recordRuntimeInjection`, I-CSB-1). */
  async recordInjection(
    runtimeId: string,
    activeMode: RuntimeMode | null,
    sandboxId: string,
  ): Promise<void> {
    if (!activeMode) return;
    const candidates = await this.repo.listByRuntime(runtimeId, false);
    const id = CredentialSelectionService.forRuntime(runtimeId, activeMode, candidates);
    if (!id) return;
    const sid = asSandboxId(sandboxId);
    const existing = await this.bindings.findActive(sid, id);
    if (existing) return; // idempotent (I-CSB-1)
    const now = this.clock.now();
    const binding = CredentialSandboxBinding.record({
      id: this.ids.next(),
      credentialId: id,
      sandboxId: sid,
      now,
    });
    this.uow.run((tx) => {
      this.bindings.saveSync(tx, binding);
      this.events.publishInTx(tx, [new CredentialInjected(id, sandboxId, now)]);
    });
  }

  /** Refresh scanner: runtime credentials whose access token is due (05 §5.1). */
  async listRefreshDue(leadMs: number): Promise<RuntimeRefreshDue[]> {
    const threshold = shiftMs(this.clock.now(), leadMs);
    const due = await this.repo.listRefreshDue(threshold);
    return due.map((c) => ({ credentialId: c.id as string, runtimeId: c.runtimeId ?? '' }));
  }

  /** Refresh write-back (05 §5.1): re-encrypt the refreshed payload atomically. */
  async applyRefresh(
    credentialId: string,
    payload: RuntimeSecretPayload,
    newExpiresAt: Date,
  ): Promise<void> {
    const secret = SecretMaterial.fromUtf8(JSON.stringify(payload));
    try {
      const encrypted = await this.crypto.encrypt(secret);
      const now = this.clock.now();
      this.uow.run((tx) =>
        this.repo.refreshSync(tx, asCredentialId(credentialId), encrypted, newExpiresAt, now),
      );
    } finally {
      secret.zeroize();
    }
  }

  /** Refresh scanner failure path: bump refresh_failures (≥3 stops, 05 §5.1). */
  async recordRefreshFailure(credentialId: string): Promise<void> {
    this.uow.run((tx) => this.repo.recordRefreshFailureSync(tx, asCredentialId(credentialId)));
  }
}
