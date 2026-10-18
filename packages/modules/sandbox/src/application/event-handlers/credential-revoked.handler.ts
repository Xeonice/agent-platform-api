import { errorMessage } from '@platform/shared-kernel';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { asSandboxId, EVENT_BUS } from '@platform/shared-kernel';
import type { DomainEvent, EventBus } from '@platform/shared-kernel';
import { CREDENTIAL_REVOCATION_FACADE } from '@platform/credential';
import type {
  CredentialRevocationBindingRef,
  CredentialRevocationFacade,
} from '@platform/credential';
import { SANDBOX_REPOSITORY } from '../../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../../domain/repositories/sandbox.repository';
import { SandboxApplicationService } from '../sandbox-application.service';

// A stopped or failed provider instance still contains its injected environment.
// Only a removed instance is safe to consider cleared.

/** Graceful teardown budget before we escalate a single binding to a force destroy (05 §4). */
const GRACEFUL_DESTROY_TIMEOUT_MS = 20_000;
/** Force-destroy budget; a container still wedged past this is left for retry (P1-b). */
const FORCE_DESTROY_TIMEOUT_MS = 15_000;

/** Resolve `p`, or reject with a timeout error after `ms` (does NOT cancel `p`). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(ms)}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(errorMessage(e), { cause: e }));
      },
    );
  });
}

/**
 * Sandbox-side revoke coordination (docs/backend/05 §4 P0-4, 23 §8.6). Subscribes to
 * `CredentialRevoked`; for each pending binding reference returned by credential,
 * the reliable action against a bound provider instance is a FORCE destroy — an injected
 * env var cannot be `unset` from outside the process (deleting a file only helps a
 * CLI that re-reads per call). Bindings are cleared CONCURRENTLY (one wedged container
 * never blocks the others); each teardown has a graceful budget that, on timeout,
 * escalates to a force destroy (05 §4 "exec 清除失败兜底"). A binding is marked cleared
 * (I-CSB-2) ONLY when its sandbox was actually torn down (or is already destroyed/gone);
 * a destroy that fails even under force KEEPS the binding for retry (P1-b) rather than
 * silently clearing it while a revoked credential is still live. A `git` revoke hits
 * ZERO bindings — that is normal and NOT an error (I3).
 */
@Injectable()
export class CredentialRevokedHandler implements OnApplicationBootstrap, OnModuleDestroy {
  private retry: NodeJS.Timeout | undefined;
  private readonly clearing = new Set<string>();
  private readonly logger = new Logger('CredentialRevokedHandler');

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CREDENTIAL_REVOCATION_FACADE)
    private readonly bindings: CredentialRevocationFacade,
    @Inject(SANDBOX_REPOSITORY) private readonly sandboxes: SandboxRepository,
    private readonly app: SandboxApplicationService,
  ) {}

  onApplicationBootstrap(): void {
    this.events.subscribe((batch) => {
      for (const e of batch) {
        if (e.type === 'CredentialRevoked')
          void this.onRevoked(e).catch((error: unknown) => {
            this.logger.error(`credential revoke scan failed: ${String(error)}`);
          });
      }
    });
    this.retry = setInterval(() => {
      void this.retryPending().catch((error: unknown) => {
        this.logger.error(`credential cleanup retry failed: ${String(error)}`);
      });
    }, 15_000);
    this.retry.unref();
    void this.retryPending().catch((error: unknown) => {
      this.logger.error(`credential cleanup recovery failed: ${String(error)}`);
    });
  }

  onModuleDestroy(): void {
    if (this.retry) clearInterval(this.retry);
  }

  async retryPending(): Promise<void> {
    await Promise.allSettled(
      (await this.bindings.listPendingRevocations()).map((binding) => this.clearBinding(binding)),
    );
  }

  async onRevoked(event: DomainEvent): Promise<void> {
    if (!('credentialId' in event) || typeof event.credentialId !== 'string') return;
    const credentialId = event.credentialId;
    if (!credentialId) return;
    const bound = await this.bindings.listForRevokedCredential(credentialId);
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
  private async clearBinding(b: CredentialRevocationBindingRef): Promise<void> {
    if (this.clearing.has(b.bindingId)) return;
    this.clearing.add(b.bindingId);
    try {
      const cleared = await this.destroyBound(b);
      if (!cleared) return;
      await this.bindings.confirmCleared(b);
    } catch (error) {
      this.logger.error(`credential cleanup pending for ${b.sandboxId}: ${String(error)}`);
    } finally {
      this.clearing.delete(b.bindingId);
    }
  }

  /**
   * Destroy any residual bound instance. Returns `true` when the binding may be
   * marked cleared: either the sandbox is gone / destroyed (nothing to do), or a destroy
   * succeeded. A graceful destroy that times out (05 §4 "exec 清除失败兜底") escalates to
   * a FORCE destroy (skip graceful stop → container `remove({force:true})`); only if THAT
   * also fails/times out do we return `false` so the binding survives for a later retry.
   */
  private async destroyBound(b: CredentialRevocationBindingRef): Promise<boolean> {
    const sandboxId = b.sandboxId;
    let sandbox;
    try {
      sandbox = await this.sandboxes.findById(asSandboxId(sandboxId));
    } catch (e) {
      this.logger.error(
        `failed to load sandbox ${sandboxId} on credential revoke: ${errorMessage(e)}`,
      );
      return false;
    }
    if (!sandbox || sandbox.status === 'destroyed') return true;

    try {
      await withTimeout(
        this.app.destroy(sandboxId, { keepVolume: true }),
        GRACEFUL_DESTROY_TIMEOUT_MS,
        `graceful destroy of ${sandboxId}`,
      );
      return true;
    } catch (graceErr) {
      this.logger.warn(
        `graceful teardown of sandbox ${sandboxId} failed/timed out; escalating to force: ${errorMessage(graceErr)}`,
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
        `force teardown of sandbox ${sandboxId} on credential revoke FAILED; binding kept for retry: ${errorMessage(forceErr)}`,
      );
      return false;
    }
  }
}
