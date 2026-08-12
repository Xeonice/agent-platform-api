import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  CLOCK,
  ID_GENERATOR,
  UNIT_OF_WORK,
  EVENT_BUS,
  asSandboxId,
  asProjectId,
} from '@platform/shared-kernel';
import type { Clock, IdGenerator, UnitOfWork, EventBus } from '@platform/shared-kernel';
import type { CreateSandboxInput, SandboxDto } from '@platform/contracts';
import { Sandbox } from '../domain/entities/sandbox.entity';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../domain/repositories/sandbox.repository';
import { SandboxMapper } from './dto/sandbox.mapper';

/**
 * Protocol-agnostic application service (02 §1): the REST controller and the MCP
 * tool BOTH inject this exact class. It orchestrates commands over the domain and
 * the synchronous UnitOfWork; it returns wire DTOs.
 *
 * It depends ONLY on ports (repository / clock / id / uow / event-bus tokens),
 * never on infrastructure implementations — boundaries lint enforces this.
 */
@Injectable()
export class SandboxApplicationService {
  constructor(
    @Inject(SANDBOX_REPOSITORY) private readonly repo: SandboxRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  create(input: CreateSandboxInput): Promise<SandboxDto> {
    const headless = input.headless ?? false;
    const sandbox = Sandbox.create({
      id: asSandboxId(this.ids.next()),
      projectId: asProjectId(input.projectId),
      runtime: input.runtime,
      headless,
      timeoutMinutes: headless ? (input.timeoutMinutes ?? 30) : null,
      idleTimeoutSec: 1800,
      now: this.clock.now(),
    });

    this.uow.run((tx) => {
      this.repo.saveSync(tx, sandbox);
      this.events.publishInTx(tx, sandbox.pullEvents());
    });

    return Promise.resolve(SandboxMapper.toDto(sandbox, false));
  }

  async get(id: string): Promise<SandboxDto> {
    const sandbox = await this.repo.findById(asSandboxId(id));
    if (!sandbox) {
      throw new NotFoundException(`sandbox ${id} not found`);
    }
    return SandboxMapper.toDto(sandbox, false);
  }

  async list(projectId?: string): Promise<SandboxDto[]> {
    if (!projectId) {
      return [];
    }
    const sandboxes = await this.repo.findByProject(asProjectId(projectId));
    return sandboxes.map((s) => SandboxMapper.toDto(s, false));
  }
}
