import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CLOCK,
  ID_GENERATOR,
  UNIT_OF_WORK,
  EVENT_BUS,
  asSandboxId,
  asProjectId,
} from '@platform/shared-kernel';
import type { Clock, IdGenerator, UnitOfWork, EventBus } from '@platform/shared-kernel';
import {
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
  SandboxProviderError,
  SandboxProviderErrorCode,
} from '@platform/contracts';
import type {
  CreateSandboxInput,
  DestroySandboxInput,
  SandboxDto,
  ProviderRegistry,
  SandboxProvider,
  SandboxHandle,
  WorkspacePreparer,
} from '@platform/contracts';
import { Sandbox } from '../domain/entities/sandbox.entity';
import type { SandboxStatus } from '../domain/value-objects/sandbox-status.vo';
import type { TriggeredBy } from '../domain/entities/state-transition.entity';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../domain/repositories/sandbox.repository';
import { SandboxMapper } from './dto/sandbox.mapper';

const DEFAULT_QUOTA = { cores: 1, ramMb: 512, diskMb: 1024 };

/**
 * Protocol-agnostic application service (02 §1): REST controller + MCP tools both
 * inject this. It orchestrates the real lifecycle pipeline
 * (pending → scheduling → preparing-workspace → creating → starting → running),
 * persisting EACH transition in a synchronous UoW with its domain event, while
 * the async provider/workspace IO happens BETWEEN transactions (24 §1.3). S1 runs
 * the pipeline inline (awaited) rather than 202+background.
 */
@Injectable()
export class SandboxApplicationService {
  constructor(
    @Inject(SANDBOX_REPOSITORY) private readonly repo: SandboxRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
    @Inject(WORKSPACE_PREPARER) private readonly workspace: WorkspacePreparer,
  ) {}

  private defaultImage(): string {
    return process.env.SANDBOX_DEFAULT_IMAGE ?? 'alpine:3.20';
  }

  async create(input: CreateSandboxInput): Promise<SandboxDto> {
    const providerName = input.provider ?? this.registry.defaultProvider;
    if (!this.registry.has(providerName)) {
      throw new BadRequestException(`unknown provider '${providerName}'`);
    }
    const provider = this.registry.get(providerName);

    const headless = input.headless ?? false;
    const sandbox = Sandbox.create({
      id: asSandboxId(this.ids.next()),
      projectId: asProjectId(input.projectId),
      runtime: input.runtime,
      provider: providerName,
      headless,
      timeoutMinutes: headless ? (input.timeoutMinutes ?? 30) : null,
      idleTimeoutSec: 1800,
      now: this.clock.now(),
    });
    this.persist(sandbox);

    await this.provision(sandbox, provider);
    return SandboxMapper.toDto(sandbox, false);
  }

  private async provision(sandbox: Sandbox, provider: SandboxProvider): Promise<void> {
    try {
      this.advance(sandbox, 'scheduling', 'scheduler');
      this.advance(sandbox, 'preparing-workspace', 'scheduler');
      const ws = await this.workspace.prepare(sandbox.id);

      this.advance(sandbox, 'creating', 'scheduler');
      const handle = await provider.create({
        sandboxId: sandbox.id,
        quota: DEFAULT_QUOTA,
        image: { ref: this.defaultImage(), digest: 'sha256:s1-placeholder' },
        env: {},
        volumes: [{ source: ws.hostPath, target: '/workspace', mode: 'rw', kind: 'host-path' }],
        labels: { 'platform.sandboxId': sandbox.id },
      });
      sandbox.bindRuntime({
        providerSandboxId: handle.providerSandboxId,
        workspacePath: ws.hostPath,
      });
      this.persist(sandbox); // save handle (no new transition/event)

      this.advance(sandbox, 'starting', 'scheduler');
      await provider.start(handle);

      this.advance(sandbox, 'running', 'scheduler');
    } catch (e) {
      this.tryAdvance(sandbox, 'failed', 'scheduler');
      await this.workspace.cleanup(sandbox.id, { keep: false }).catch(() => undefined);
      throw this.mapProviderError(e);
    }
  }

  async get(id: string): Promise<SandboxDto> {
    const sandbox = await this.repo.findById(asSandboxId(id));
    if (!sandbox) throw new NotFoundException(`sandbox ${id} not found`);
    return SandboxMapper.toDto(sandbox, false);
  }

  async list(projectId?: string): Promise<SandboxDto[]> {
    if (!projectId) return [];
    const sandboxes = await this.repo.findByProject(asProjectId(projectId));
    return sandboxes.map((s) => SandboxMapper.toDto(s, false));
  }

  async destroy(id: string, input: DestroySandboxInput = {}): Promise<void> {
    const sandbox = await this.repo.findById(asSandboxId(id));
    if (!sandbox) throw new NotFoundException(`sandbox ${id} not found`);
    const provider = this.registry.get(sandbox.provider);
    const handle = this.handleOf(sandbox);

    try {
      if (sandbox.status === 'running' || sandbox.status === 'idle') {
        this.advance(sandbox, 'stopping', 'user');
        if (handle) await provider.stop(handle);
        this.advance(sandbox, 'stopped', 'user');
      }
      this.advance(sandbox, 'destroying', 'user');
      if (handle) await provider.destroy(handle);
      await this.workspace.cleanup(id, { keep: input.keepVolume ?? false });
      this.advance(sandbox, 'destroyed', 'user');
    } catch (e) {
      this.tryAdvance(sandbox, 'failed', 'user');
      throw this.mapProviderError(e);
    }
  }

  private handleOf(sandbox: Sandbox): SandboxHandle | null {
    return sandbox.providerSandboxId
      ? { provider: sandbox.provider, providerSandboxId: sandbox.providerSandboxId }
      : null;
  }

  private advance(sandbox: Sandbox, to: SandboxStatus, by: TriggeredBy): void {
    sandbox.transitionTo(to, by, this.clock.now());
    this.persist(sandbox);
  }

  private tryAdvance(sandbox: Sandbox, to: SandboxStatus, by: TriggeredBy): void {
    try {
      this.advance(sandbox, to, by);
    } catch {
      // best-effort failure marking; ignore illegal-transition from a terminal state
    }
  }

  private persist(sandbox: Sandbox): void {
    this.uow.run((tx) => {
      this.repo.saveSync(tx, sandbox);
      this.events.publishInTx(tx, sandbox.pullEvents());
    });
  }

  /** Map provider (contract) errors to HTTP (04 §4 interface mapping). */
  private mapProviderError(e: unknown): unknown {
    if (e instanceof HttpException) return e;
    if (!(e instanceof SandboxProviderError)) return e;
    const status = PROVIDER_HTTP[e.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
    return new HttpException({ code: e.code, message: e.message, retryable: e.retryable }, status);
  }
}

const PROVIDER_HTTP: Record<SandboxProviderErrorCode, number> = {
  [SandboxProviderErrorCode.IMAGE_PULL_FAILED]: HttpStatus.BAD_GATEWAY,
  [SandboxProviderErrorCode.PROVIDER_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
  [SandboxProviderErrorCode.RESOURCE_EXHAUSTED]: HttpStatus.TOO_MANY_REQUESTS,
  [SandboxProviderErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [SandboxProviderErrorCode.ALREADY_EXISTS]: HttpStatus.CONFLICT,
  [SandboxProviderErrorCode.INVALID_STATE]: HttpStatus.CONFLICT,
  [SandboxProviderErrorCode.PERMISSION_DENIED]: HttpStatus.FORBIDDEN,
  [SandboxProviderErrorCode.TIMEOUT]: HttpStatus.GATEWAY_TIMEOUT,
  [SandboxProviderErrorCode.UNSUPPORTED_CAPABILITY]: HttpStatus.CONFLICT,
  [SandboxProviderErrorCode.INTERNAL]: HttpStatus.INTERNAL_SERVER_ERROR,
};
