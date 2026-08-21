import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CLOCK, EVENT_BUS, UNIT_OF_WORK, asCredentialId } from '@platform/shared-kernel';
import type { Clock, DomainEvent, EventBus, UnitOfWork } from '@platform/shared-kernel';
import { CREDENTIAL_SANDBOX_BINDING_REPOSITORY } from '@platform/credential';
import type {
  CredentialSandboxBinding,
  CredentialSandboxBindingRepository,
} from '@platform/credential';
import { SANDBOX_REPOSITORY } from '../../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../../domain/repositories/sandbox.repository';
import { SandboxApplicationService } from '../sandbox-application.service';

/** Sandbox statuses for which a revoked credential is still "in use" (live). */
const LIVE = new Set(['running', 'idle', 'starting']);

/** Graceful teardown budget before we escalate a single binding to a force destroy (05 §4). */
const GRACEFUL_DESTROY_TIMEOUT_MS = 20_000;
/** Force-destroy budget; a container still wedged past this is left for retry (P1-b). */
const FORCE_DESTROY_TIMEOUT_MS = 15_000;

/** Resolve `p`, or reject with a timeout error after `ms` (does NOT cancel `p`). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/**
 * Sandbox-side revoke coordination (docs/backend/05 §4 P0-4, 23 §8.6). Subscribes to
 * `CredentialRevoked`; for each `credential_sandbox_bindings` row of that credential,
 * the ONLY reliable action against a LIVE sandbox is a FORCE destroy — an injected
 * env var cannot be `unset` from outside the process (deleting a file only helps a
 * CLI that re-reads per call). Bindings are cleared CONCURRENTLY (one wedged container
 * never blocks the others); each teardown has a graceful budget that, on timeout,
 * escalates to a force destroy (05 §4 "exec 清除失败兜底"). A binding is marked cleared
 * (I-CSB-2) ONLY when its sandbox was actually torn down (or is already gone/non-live);
 * a destroy that fails even under force KEEPS the binding for retry (P1-b) rather than
 * silently clearing it while a revoked credential is still live. A `git` revoke hits
 * ZERO bindings — that is normal and NOT an error (I3).
 */
@Injectable()
export class CredentialRevokedHandler implements OnApplicationBootstrap {
  private readonly logger = new Logger('CredentialRevokedHandler');

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CREDENTIAL_SANDBOX_BINDING_REPOSITORY)
    private readonly bindings: CredentialSandboxBindingRepository,
    @Inject(SANDBOX_REPOSITORY) private readonly sandboxes: SandboxRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly app: SandboxApplicationService,
  ) {}

  onApplicationBootstrap(): void {
    this.events.subscribe((batch) => {
      for (const e of batch) {
        if (e.type === 'CredentialRevoked') void this.onRevoked(e);
      }
    });
  }

  async onRevoked(event: DomainEvent): Promise<void> {
    const credentialId = (event as { credentialId?: string }).credentialId;
    if (!credentialId) return;
    const bound = await this.bindings.listByCredential(asCredentialId(credentialId), false);
    // Tear the bound sandboxes down CONCURRENTLY and INDEPENDENTLY (P0-1 ②): a single
    // wedged container must never stall the queue for the other sandboxes that share
    // this revoked credential. Each binding owns its own timeout + try/catch.
    await Promise.allSettled(bound.map((b) => this.clearBinding(b)));
  }

  /**
   * Tear down ONE bound sandbox, then clear its binding — but ONLY if the teardown
   * actually succeeded (P1-b): a failed/timed-out destroy leaves the binding intact so
   * a retry / compensation can still target the residual live sandbox, rather than
   * marking it "cleared" while a revoked credential is still injected in a live process.
   */
  private async clearBinding(b: CredentialSandboxBinding): Promise<void> {
    const cleared = await this.destroyBound(b);
    if (!cleared) return; // keep the binding for retry — do NOT mark cleared
    const now = this.clock.now();
    this.uow.run((tx) => this.bindings.markClearedSync(tx, b.id, now));
  }

  /**
   * Destroy a bound sandbox if it is still live. Returns `true` when the binding may be
   * marked cleared: either the sandbox is gone / non-live (nothing to do), or a destroy
   * succeeded. A graceful destroy that times out (05 §4 "exec 清除失败兜底") escalates to
   * a FORCE destroy (skip graceful stop → container `remove({force:true})`); only if THAT
   * also fails/times out do we return `false` so the binding survives for a later retry.
   */
  private async destroyBound(b: CredentialSandboxBinding): Promise<boolean> {
    const sandboxId = b.sandboxId as string;
    let sandbox;
    try {
      sandbox = await this.sandboxes.findById(b.sandboxId);
    } catch (e) {
      this.logger.error(
        `failed to load sandbox ${sandboxId} on credential revoke: ${(e as Error).message}`,
      );
      return false;
    }
    if (!sandbox || !LIVE.has(sandbox.status)) return true; // nothing live to tear down

    try {
      await withTimeout(
        this.app.destroy(sandboxId, { keepVolume: true }),
        GRACEFUL_DESTROY_TIMEOUT_MS,
        `graceful destroy of ${sandboxId}`,
      );
      return true;
    } catch (graceErr) {
      this.logger.warn(
        `graceful teardown of sandbox ${sandboxId} failed/timed out; escalating to force: ${(graceErr as Error).message}`,
      );
    }

    try {
      await withTimeout(
        // S5 hook: prepare→inject→record is the injection path; here we UN-inject by
        // force-destroying the sandbox (env vars can't be unset from outside — 05 §4).
        this.app.destroy(sandboxId, { keepVolume: true, force: true }),
        FORCE_DESTROY_TIMEOUT_MS,
        `force destroy of ${sandboxId}`,
      );
      return true;
    } catch (forceErr) {
      // Not silent (05 §4): a wedged container is a logged error, and the binding is
      // KEPT (return false) so it stays in the retriable set (P1-b).
      this.logger.error(
        `force teardown of sandbox ${sandboxId} on credential revoke FAILED; binding kept for retry: ${(forceErr as Error).message}`,
      );
      return false;
    }
  }
}
