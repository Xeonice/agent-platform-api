import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CLOCK, EVENT_BUS, UNIT_OF_WORK, asCredentialId } from '@platform/shared-kernel';
import type { Clock, DomainEvent, EventBus, UnitOfWork } from '@platform/shared-kernel';
import { CREDENTIAL_SANDBOX_BINDING_REPOSITORY } from '@platform/credential';
import type { CredentialSandboxBindingRepository } from '@platform/credential';
import { SANDBOX_REPOSITORY } from '../../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../../domain/repositories/sandbox.repository';
import { SandboxApplicationService } from '../sandbox-application.service';

/** Sandbox statuses for which a revoked credential is still "in use" (live). */
const LIVE = new Set(['running', 'idle', 'starting']);

/**
 * Sandbox-side revoke coordination (docs/backend/05 §4 P0-4, 23 §8.6). Subscribes to
 * `CredentialRevoked`; for each `credential_sandbox_bindings` row of that credential,
 * the ONLY reliable action against a LIVE sandbox is a FORCE destroy — an injected
 * env var cannot be `unset` from outside the process (deleting a file only helps a
 * CLI that re-reads per call). Best-effort: an exec/teardown failure is logged, not
 * swallowed silently, and the binding is marked cleared (I-CSB-2). A `git` revoke
 * hits ZERO bindings — that is normal and NOT an error (I3).
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
    for (const b of bound) {
      try {
        const sandbox = await this.sandboxes.findById(b.sandboxId);
        if (sandbox && LIVE.has(sandbox.status)) {
          await this.app.destroy(b.sandboxId as string, { keepVolume: true });
        }
      } catch (e) {
        // exec/teardown failure escalates to a logged error (not silent, P0-4).
        this.logger.error(
          `failed to tear down sandbox ${b.sandboxId} on credential revoke: ${(e as Error).message}`,
        );
      } finally {
        const now = this.clock.now();
        this.uow.run((tx) => this.bindings.markClearedSync(tx, b.id, now));
      }
    }
  }
}
