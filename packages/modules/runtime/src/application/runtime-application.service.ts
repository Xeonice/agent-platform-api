import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK, shiftMs } from '@platform/shared-kernel';
import type { Clock, IdGenerator, UnitOfWork } from '@platform/shared-kernel';
import { RUNTIME_ADAPTER_REGISTRY } from '@platform/contracts';
import type {
  AuthChallengeDto,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeAuthMethod,
  RuntimeAuthMode,
  RuntimeCredential,
  RuntimeDto,
  RuntimeSettingsDto,
} from '@platform/contracts';
import { RuntimeCredentialService } from '@platform/credential';
import type { RuntimeSecretPayload } from '@platform/credential';
import { AUTH_HELPER } from '../domain/ports/auth-helper.port';
import type { AuthHelper, AuthHelperSession } from '../domain/ports/auth-helper.port';
import { AuthSessionStore } from './auth-session.store';
import type { AuthOutcomeStatus } from './auth-session.store';
import { AuthChallenge } from '../domain/value-objects/auth-challenge.vo';
import { RuntimeSettings } from '../domain/entities/runtime-settings.entity';
import {
  AuthMethodPolicy,
  UnsupportedAuthMethodError,
} from '../domain/services/auth-method.policy';
import { RUNTIME_SETTINGS_REPOSITORY } from '../domain/repositories/runtime-settings.repository';
import type { RuntimeSettingsRepository } from '../domain/repositories/runtime-settings.repository';
import { AdapterAuthError } from '../domain/errors/adapter-auth.error';

/** Device-code challenge lifetime (05 §1 ★2: 15min). */
const DEVICE_CODE_TTL_MS = 15 * 60_000;
/** Access-token / token lifetimes per method (05 §5: codex hourly, claude ~1yr). */
const CODEX_ACCESS_TTL_MS = 60 * 60_000;
const CLAUDE_TOKEN_TTL_MS = 365 * 24 * 60 * 60_000;

@Injectable()
export class RuntimeApplicationService {
  private readonly logger = new Logger('RuntimeApplicationService');

  constructor(
    @Inject(RUNTIME_ADAPTER_REGISTRY) private readonly registry: RuntimeAdapterRegistry,
    @Inject(AUTH_HELPER) private readonly helper: AuthHelper,
    @Inject(RUNTIME_SETTINGS_REPOSITORY) private readonly settings: RuntimeSettingsRepository,
    private readonly sessions: AuthSessionStore,
    private readonly credentials: RuntimeCredentialService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /** GET /api/runtimes — aggregate rows with credential status (27 §4, no N+1). */
  async listRuntimes(): Promise<RuntimeDto[]> {
    return Promise.all(this.registry.list().map((a) => this.toRuntimeDto(a)));
  }

  async getCredentialStatus(runtimeId: string): Promise<RuntimeDto> {
    return this.toRuntimeDto(this.adapter(runtimeId));
  }

  private async toRuntimeDto(adapter: RuntimeAdapter): Promise<RuntimeDto> {
    const settings = await this.settings.findByRuntime(adapter.id);
    const mode = settings?.activeAuthMethod ?? null;
    const [view, credentials] = await Promise.all([
      this.credentials.view(adapter.id, mode),
      this.credentials.listSummaries(adapter.id),
    ]);
    const authMethods = adapter.getAuthMethods().filter((m) => m !== 'access-token-paste');
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      vendor: adapter.vendor,
      authMethods,
      credentialStatus: view.credentialStatus,
      maskedIdentifier: view.maskedIdentifier,
      expiresAt: view.expiresAt,
      activeAuthMethod: mode ?? undefined,
      // per-mode parallel cards (P21-3 §3); each row carries its own credentialId
      credentials,
    };
  }

  /** POST .../auth/begin — start the login in the auth helper (05 §3). */
  async beginAuth(runtimeId: string, method: RuntimeAuthMethod): Promise<AuthChallengeDto> {
    const adapter = this.adapter(runtimeId);
    try {
      AuthMethodPolicy.assertSupported(method, adapter.getAuthMethods());
    } catch (e) {
      if (e instanceof UnsupportedAuthMethodError) throw new BadRequestException(e.message);
      throw e;
    }
    const challengeRef = this.ids.next();
    const deviceCodeExpiresAt = shiftMs(this.clock.now(), DEVICE_CODE_TTL_MS).toISOString();

    let session: AuthHelperSession;
    try {
      session = await this.helper.openSession(adapter.loginCommand(method));
    } catch (e) {
      throw new ServiceUnavailableException(
        `auth helper unavailable: ${(e as Error).message} (PROVIDER_UNAVAILABLE)`,
      );
    }

    try {
      const raw = await adapter.beginAuth(method, {
        pty: session.pty,
        homeDir: session.homeDir,
        challengeRef,
        deviceCodeExpiresAt: method === 'oauth-device' ? deviceCodeExpiresAt : undefined,
      });
      const challenge = AuthChallenge.create(raw);
      const expiresAt = shiftMs(this.clock.now(), DEVICE_CODE_TTL_MS);
      this.sessions.put({
        challengeRef,
        runtimeId,
        session,
        challenge,
        expiresAt,
        status: 'pending',
      });
      // device-code flow completes asynchronously (the user authorizes in a browser);
      // drive completion in the background so `pollAuthStatus` can report success.
      if (challenge.kind === 'device-code') {
        void this.awaitDeviceCompletion(runtimeId, challengeRef);
      }
      return challenge.toDto();
    } catch (e) {
      await session.dispose();
      throw this.mapAdapterError(e);
    }
  }

  /** GET .../auth/status?challengeRef= — device-code poll (05 §3). */
  async pollAuthStatus(
    runtimeId: string,
    challengeRef: string,
  ): Promise<{ status: 'pending' | 'success' | 'expired' | 'error'; maskedIdentifier?: string }> {
    const now = this.clock.now();
    const entry = this.sessions.get(challengeRef);
    if (entry && entry.runtimeId === runtimeId) {
      // still live: a pending challenge past its TTL reads as `expired`.
      if (entry.status === 'pending' && entry.expiresAt.getTime() <= now.getTime()) {
        return { status: 'expired' };
      }
      return { status: entry.status, maskedIdentifier: entry.maskedIdentifier };
    }
    // The live entry is gone — a settled device-code login leaves a terminal tombstone
    // (success/error/expired) so the frontend's next poll still sees a TRUE terminal
    // state instead of a bare 404 (P2; the frontend's assumed-dead fix depends on this).
    const outcome = this.sessions.outcome(challengeRef, now);
    if (outcome && outcome.runtimeId === runtimeId) {
      return { status: outcome.status, maskedIdentifier: outcome.maskedIdentifier };
    }
    throw new NotFoundException(`unknown challengeRef ${challengeRef}`);
  }

  /** POST .../auth/complete — setup-token paste (05 §3). */
  async completeAuth(
    runtimeId: string,
    challengeRef: string,
    pastedText?: string,
  ): Promise<{ maskedIdentifier: string }> {
    const entry = this.sessions.getLive(challengeRef, this.clock.now());
    if (!entry || entry.runtimeId !== runtimeId) {
      throw new NotFoundException(`challenge ${challengeRef} expired or unknown`);
    }
    const adapter = this.adapter(runtimeId);
    try {
      const cred = await adapter.completeAuth(
        entry.challenge.toDto(),
        { pastedText },
        {
          pty: entry.session.pty,
          homeDir: entry.session.homeDir,
          challengeRef,
          deviceCodeExpiresAt: entry.challenge.expiresAt,
        },
      );
      const masked = await this.storeCredential(runtimeId, cred);
      entry.status = 'success';
      entry.maskedIdentifier = masked;
      return { maskedIdentifier: masked };
    } catch (e) {
      entry.status = 'error';
      throw this.mapAdapterError(e);
    } finally {
      await entry.session.dispose();
      this.sessions.delete(challengeRef);
    }
  }

  /** Background completion for device-code logins. */
  private async awaitDeviceCompletion(runtimeId: string, challengeRef: string): Promise<void> {
    const entry = this.sessions.get(challengeRef);
    if (!entry) return;
    const adapter = this.adapter(runtimeId);
    let status: AuthOutcomeStatus = 'error';
    let maskedIdentifier: string | undefined;
    try {
      const cred = await adapter.completeAuth(
        entry.challenge.toDto(),
        {},
        {
          pty: entry.session.pty,
          homeDir: entry.session.homeDir,
          challengeRef,
          deviceCodeExpiresAt: entry.challenge.expiresAt,
        },
      );
      maskedIdentifier = await this.storeCredential(runtimeId, cred);
      status = 'success';
    } catch (e) {
      // an expired challenge surfaces as a distinct `expired` terminal (vs generic error)
      // so the frontend can guide "code expired → restart" rather than "login failed".
      status =
        e instanceof AdapterAuthError && e.code === 'AUTH_CHALLENGE_EXPIRED' ? 'expired' : 'error';
      this.logger.warn(`device login ${challengeRef} failed: ${(e as Error).message}`);
    } finally {
      await entry.session.dispose();
      // Drop the heavy live entry (releasing the pty session) and retain only the tiny
      // terminal tombstone for subsequent polls (P2 memory leak fix).
      this.sessions.settle(challengeRef, {
        runtimeId,
        status,
        maskedIdentifier,
        evictAt: entry.expiresAt,
      });
      // opportunistically drop any tombstones the frontend never polled (bounds growth).
      this.sessions.sweepOutcomes(this.clock.now());
    }
  }

  /** POST .../credentials/secret — api-key short-circuit (05 §3.1). NO helper/pty. */
  async submitSecret(runtimeId: string, secret: string): Promise<{ maskedIdentifier: string }> {
    const adapter = this.adapter(runtimeId);
    if (!adapter.createCredentialFromSecret) {
      throw new BadRequestException(`${runtimeId} does not support api-key`);
    }
    // The adapter owns its provider's key FORMAT (05 §3.1) — no `runtimeId === 'codex'`
    // branch here; an adapter without a check imposes no format constraint.
    const verdict = adapter.validateApiKey?.(secret) ?? { ok: true };
    if (!verdict.ok) {
      // never echo the value (P2-3) — only the reason.
      throw new UnauthorizedException(`invalid api key: ${verdict.reason} (AUTH_REJECTED)`);
    }
    const cred = await adapter.createCredentialFromSecret('api-key', secret);
    const masked = await this.storeCredential(runtimeId, cred);
    return { maskedIdentifier: masked };
  }

  /** PUT .../auth-mode — switch mode; I-RTS-2 target-mode-has-no-credential → 409. */
  async setAuthMode(runtimeId: string, mode: RuntimeAuthMode): Promise<RuntimeSettingsDto> {
    this.adapter(runtimeId); // 404 for unknown runtime
    const view = await this.credentials.view(runtimeId, mode);
    if (view.credentialStatus === 'none') {
      throw new ConflictException(
        `no ${mode} credential configured for ${runtimeId} — configure it first`,
      );
    }
    const now = this.clock.now();
    const existing = await this.settings.findByRuntime(runtimeId);
    const settings = existing ?? RuntimeSettings.create(runtimeId, mode, now);
    if (existing) existing.switchTo(mode, now);
    this.uow.run((tx) => this.settings.saveSync(tx, settings));
    return { runtimeId, activeAuthMethod: settings.activeAuthMethod };
  }

  /** DELETE .../credentials/:id — revoke (05 §4; triggers sandbox revoke coordination). */
  async revokeCredential(runtimeId: string, credentialId: string): Promise<void> {
    this.adapter(runtimeId);
    await this.credentials.revoke(runtimeId, credentialId);
  }

  /** Build the store input from an adapter credential + compute expiry, then store. */
  private async storeCredential(runtimeId: string, cred: RuntimeCredential): Promise<string> {
    try {
      const payload: RuntimeSecretPayload = {
        credentialFiles: cred.credentialFiles.length > 0 ? cred.credentialFiles : undefined,
        env: cred.env,
        accessToken: cred.accessToken,
        authFile: cred.authFile,
      };
      const { maskedIdentifier } = await this.credentials.storeRuntimeCredential({
        runtimeId,
        obtainedVia: cred.obtainedVia,
        maskedIdentifier: cred.maskedIdentifier ?? runtimeId,
        payload,
        expiresAt: this.expiryFor(cred.obtainedVia),
      });
      return maskedIdentifier;
    } finally {
      cred.zeroize();
    }
  }

  private expiryFor(method: RuntimeAuthMethod): Date | null {
    if (method === 'oauth-device') return shiftMs(this.clock.now(), CODEX_ACCESS_TTL_MS);
    if (method === 'setup-token') return shiftMs(this.clock.now(), CLAUDE_TOKEN_TTL_MS);
    return null; // api-key / access-token-paste: no platform expiry
  }

  private adapter(runtimeId: string): RuntimeAdapter {
    if (!this.registry.has(runtimeId)) {
      throw new NotFoundException(`unknown runtime '${runtimeId}'`);
    }
    return this.registry.get(runtimeId);
  }

  private mapAdapterError(e: unknown): unknown {
    if (e instanceof AdapterAuthError) {
      switch (e.code) {
        case 'UNSUPPORTED_METHOD':
          return new BadRequestException(e.message);
        case 'AUTH_CHALLENGE_EXPIRED':
          return new NotFoundException(e.message); // 410-ish; mapped to 404 for MVP
        case 'AUTH_REJECTED':
          return new UnauthorizedException(e.message);
        default:
          return e;
      }
    }
    return e;
  }
}
