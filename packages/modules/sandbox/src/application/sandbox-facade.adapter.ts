import { Inject, Injectable } from '@nestjs/common';
import type { SandboxFacade } from '@platform/contracts';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../domain/repositories/sandbox.repository';

/**
 * Implements the cross-context `SandboxFacade` (contracts) so the `project`
 * context can aggregate a per-project Task count WITHOUT importing the sandbox
 * domain. Counts LIVE sandboxes (everything except the terminal `destroyed`
 * state) in ONE grouped query (no N+1).
 */
@Injectable()
export class SandboxFacadeAdapter implements SandboxFacade {
  constructor(@Inject(SANDBOX_REPOSITORY) private readonly repo: SandboxRepository) {}

  countByProject(projectIds: string[]): Promise<Record<string, number>> {
    return this.repo.countActiveByProject(projectIds);
  }
}
