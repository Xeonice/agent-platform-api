import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CLOCK, shiftMs } from '@platform/shared-kernel';
import type { Clock } from '@platform/shared-kernel';
import { RUNTIME_ADAPTER_REGISTRY } from '@platform/contracts';
import type { RuntimeAdapterRegistry } from '@platform/contracts';
import { RuntimeCredentialService } from '@platform/credential';
import type { RuntimeSecretPayload } from '@platform/credential';
import { AUTH_HELPER } from '../../domain/ports/auth-helper.port';
import type { AuthHelper } from '../../domain/ports/auth-helper.port';

/** Scan cadence + how far ahead of expiry to refresh + the new token TTL (05 §5.1). */
const SCAN_INTERVAL_MS = 15 * 60_000;
const REFRESH_LEAD_MS = 30 * 60_000;
/** TTL of the CLI-refreshed access token (codex-class hourly default, 05 §5.1). */
const REFRESHED_ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_CMD_TIMEOUT_MS = 60_000;

/**
 * Credential refresh scanner (docs/backend/05 §5.1, method A: let the CLI refresh
 * itself). Applies ONLY to runtimes whose adapter declares a `refreshCapability`
 * (claude setup-token ~1yr no-refresh & api-key no expiry declare none, so they are
 * skipped). Every 15min: for each due credential, look up its runtime's adapter, seed
 * a FRESH isolated helper HOME with the current auth file, run the adapter's probe
 * command that triggers the CLI's own refresh, parse the rewritten auth file via the
 * adapter, and atomically write the new access token to the vault (`refreshSync`).
 *
 * Concurrency (P2-1): a process-wide single-instance lock + per-credential in-flight
 * set, SHARED with any manual trigger, so one credential is never refreshed twice
 * concurrently (avoids the token write-back race that rejected method B). ≥3
 * consecutive failures stop (`recordRefreshFailure` → presented as expired).
 */
@Injectable()
export class CredentialRefreshScanner implements OnApplicationBootstrap {
  private readonly logger = new Logger('CredentialRefreshScanner');
  private running = false;
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(AUTH_HELPER) private readonly helper: AuthHelper,
    private readonly credentials: RuntimeCredentialService,
    @Inject(RUNTIME_ADAPTER_REGISTRY) private readonly registry: RuntimeAdapterRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.DISABLE_CREDENTIAL_REFRESH_SCANNER === '1') return;
    this.timer = setInterval(() => void this.runOnce(), SCAN_INTERVAL_MS);
    // do not keep the event loop alive purely for the scanner
    this.timer.unref?.();
  }

  /** One scan pass. Idempotent under the single-instance lock. */
  async runOnce(): Promise<void> {
    if (this.running) return; // single-instance lock (P2-1)
    this.running = true;
    try {
      const due = await this.credentials.listRefreshDue(REFRESH_LEAD_MS);
      for (const item of due) {
        if (this.inFlight.has(item.credentialId)) continue; // per-cred in-flight dedup
        this.inFlight.add(item.credentialId);
        try {
          await this.refreshOne(item.credentialId, item.runtimeId);
        } catch (e) {
          this.logger.warn(`refresh failed for ${item.credentialId}: ${(e as Error).message}`);
          await this.credentials.recordRefreshFailure(item.credentialId);
        } finally {
          this.inFlight.delete(item.credentialId);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async refreshOne(credentialId: string, runtimeId: string): Promise<void> {
    // Dispatch to the runtime's adapter: only a runtime that DECLARED a
    // refreshCapability is refreshed here (05 §5.1). Others (claude setup-token /
    // api-key, or any new runtime without one) are skipped gracefully — no error,
    // no failure recorded, no scanner-side `runtimeId === 'codex'` branch.
    const cap = this.registry.has(runtimeId)
      ? this.registry.get(runtimeId).refreshCapability
      : undefined;
    if (!cap) return;
    const mat = await this.credentials.materializeById(credentialId);
    try {
      if (!mat.authFile)
        throw new Error('no auth file to refresh (credential carries no account auth material)');
      const session = await this.helper.openSession(cap.probeCommand, [
        { relPath: 'auth.json', content: mat.authFile, mode: 0o600 },
      ]);
      try {
        await this.waitForExit(session.pty, REFRESH_CMD_TIMEOUT_MS);
        const raw = await readFile(join(session.homeDir, 'auth.json'), 'utf8');
        const { accessToken } = cap.parseRefreshedAuth(raw);
        if (!accessToken) throw new Error('refreshed auth file missing access token');
        const payload: RuntimeSecretPayload = { accessToken, authFile: raw };
        await this.credentials.applyRefresh(
          credentialId,
          payload,
          shiftMs(this.clock.now(), REFRESHED_ACCESS_TTL_MS),
        );
      } finally {
        await session.dispose();
      }
    } finally {
      mat.zeroize();
    }
  }

  private waitForExit(
    pty: { onExit(cb: (code: number | null) => void): void },
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      pty.onExit(() => finish());
      setTimeout(finish, timeoutMs);
    });
  }
}
