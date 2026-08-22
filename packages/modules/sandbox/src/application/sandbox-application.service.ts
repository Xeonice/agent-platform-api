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
  ImageContractViolationError,
  RuntimeInstallFailedError,
  RUNTIME_ADAPTER_REGISTRY,
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
  PROJECT_FACADE,
  ProjectAccessError,
  SandboxProviderError,
  SandboxProviderErrorCode,
} from '@platform/contracts';
import type {
  CreateSandboxInput,
  DestroySandboxInput,
  ProviderDto,
  RequiredCapabilities,
  RuntimeAdapterRegistry,
  SandboxDto,
  ProviderRegistry,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxHandle,
  WorkspacePreparer,
  ProjectFacade,
  ProjectRuntimeContext,
} from '@platform/contracts';
import { ProvisionSandboxWorkflow } from './workflows/provision-sandbox.workflow';
import { Sandbox } from '../domain/entities/sandbox.entity';
import type { SandboxStatus } from '../domain/value-objects/sandbox-status.vo';
import type { TriggeredBy } from '../domain/entities/state-transition.entity';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../domain/repositories/sandbox.repository';
import { SandboxMapper } from './dto/sandbox.mapper';

/**
 * Protocol-agnostic application service (02 §1): REST controller + MCP tools both
 * inject this. It owns the SYNCHRONOUS half — the create transaction T1 and teardown
 * — and hands everything after the 202 to `ProvisionSandboxWorkflow` (26 §1), which
 * is where the staged pipeline and its per-stage compensation live.
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
    @Inject(PROJECT_FACADE) private readonly projectFacade: ProjectFacade,
    @Inject(RUNTIME_ADAPTER_REGISTRY) private readonly runtimes: RuntimeAdapterRegistry,
    private readonly provision: ProvisionSandboxWorkflow,
  ) {}

  private defaultImage(): string {
    return process.env.SANDBOX_DEFAULT_IMAGE ?? 'alpine:3.20';
  }

  /**
   * `GET /api/providers` — read-only capability discovery (04 §5 「能力发现」). The list
   * IS the registry: a provider registered by an out-of-tree module appears here with
   * no change to this method, and the frontend drives its per-capability UI (e.g. no
   * `pauseResume` ⇒ no "暂停" button) off these bits instead of a hard-coded list.
   */
  listProviders(): ProviderDto[] {
    const defaultProvider = this.registry.defaultProvider;
    return this.registry.list().map((p) => ({
      name: p.name,
      capabilities: {
        spawnTty: p.capabilities.spawnTty,
        volumeMount: p.capabilities.volumeMount,
        updateResources: p.capabilities.updateResources,
        pauseResume: p.capabilities.pauseResume,
        snapshot: p.capabilities.snapshot,
        watchEvents: p.capabilities.watchEvents,
      },
      isDefault: p.name === defaultProvider,
    }));
  }

  async create(input: CreateSandboxInput): Promise<SandboxDto> {
    const providerName = input.provider ?? this.registry.defaultProvider;
    if (!this.registry.has(providerName)) {
      throw new BadRequestException(`unknown provider '${providerName}'`);
    }
    const provider = this.registry.get(providerName);
    // 04 §5 「创建前静态校验」: capability mismatches are rejected HERE — before the
    // project lookup, before a row is written, before anything is scheduled.
    this.assertCapabilities(provider, input.require);
    const imageRef = this.resolveImage(input.image);

    // validate the project + resolve its baseline AT CREATE time (S2, 26 §3 link①):
    // the facade runs Project.assertCanAcceptTask and throws ProjectAccessError,
    // which we surface as HTTP BEFORE any sandbox row is written.
    const projectCtx = await this.resolveProject(input.projectId);

    const headless = input.headless ?? false;
    const sandbox = Sandbox.create({
      id: asSandboxId(this.ids.next()),
      projectId: asProjectId(input.projectId),
      runtime: input.runtime,
      runtimeLabel: this.runtimeLabel(input.runtime),
      provider: providerName,
      imageRef,
      headless,
      // T-1: the instruction is PERSISTED here, in T1. Its consumer
      // (`bootstrapAgentSession`) runs after the 202 in a workflow whose only input is
      // a `sandboxId` (26 §1) — anything crossing that boundary needs storage, and the
      // queue is an in-memory FIFO, i.e. a strictly weaker store than the DB.
      initialPrompt: input.initialPrompt,
      timeoutMinutes: headless ? (input.timeoutMinutes ?? 30) : null,
      idleTimeoutSec: 1800,
      now: this.clock.now(),
    });
    this.persist(sandbox);

    // ASYNC lifecycle (03 / P20 §3.3 four-phase progress card): the request path
    // MUST NOT block on provision→start→agent-readiness — boxlite cold-pull alone
    // is ~220s, and a cold runtime-CLI install was measured at 753s. Snapshot the
    // `pending` DTO NOW (before provision runs — it advances the aggregate
    // synchronously up to its first await), return it immediately, and let provision
    // drive the state machine in the background (each transition persists + publishes
    // a SandboxStateChanged event for the WS relay). Failures land `failed`.
    const dto = SandboxMapper.toDto(sandbox, false);
    void this.provision.runSafely(sandbox, provider, projectCtx.baselinePath);
    return dto;
  }

  /**
   * The image to run (TASK-LAUNCH-DECISIONS §3★1). Until S5 this input was ACCEPTED
   * on the wire and then silently ignored — every sandbox ran the default image, which
   * would have made `getInstallPlan(imageSpec)` a permanently constant answer and voided
   * the entire "(image, runtime) pair" conclusion.
   *
   * ⚠️ SCOPE: only shape validation happens here. `I-IMG-2` (reject an `invalid`
   * manifest) and `I-IMG-3` (only `is_active` images are selectable) are NOT
   * implementable yet — there is no image context at all: no `images` /
   * `image_manifests` tables, no `ImageSpecProvider`, and `IMAGE_SPEC_REGISTRY` is a
   * bare placeholder token (04 §8). Those two invariants land with the image slice.
   */
  private resolveImage(requested?: string): string {
    const ref = (requested ?? '').trim();
    if (ref === '') return this.defaultImage();
    // whitespace / control characters in an image ref would flow into a container
    // runtime call; refuse them up front rather than deep inside `provider.create`.
    if (/\s/.test(ref)) {
      throw new BadRequestException(`invalid image reference '${requested}'`);
    }
    return ref;
  }

  /** Human-facing runtime label for the fallback task name (P21-1 §9). */
  private runtimeLabel(runtimeId: string): string {
    return this.runtimes.has(runtimeId) ? this.runtimes.get(runtimeId).displayName : runtimeId;
  }

  /**
   * Static capability negotiation (04 §5), the ONLY producer of `UNSUPPORTED_CAPABILITY`:
   *
   *   ① every bit the request explicitly demands must be advertised by the provider —
   *     `require: { snapshot: true }` against a provider without checkpoint support is
   *     rejected outright rather than failing deep inside provisioning;
   *   ② `spawnTty` is required UNCONDITIONALLY (04 §2.5 spawnTty row): every agent
   *     runtime here needs a TTY for the terminal page and the runtime auth entry, so a
   *     provider that cannot spawn one can never host a sandbox on this platform.
   *
   * Both throw BEFORE scheduling, so `provider.create` is never reached.
   */
  private assertCapabilities(provider: SandboxProvider, require?: RequiredCapabilities): void {
    const caps = provider.capabilities;
    for (const [bit, demanded] of Object.entries(require ?? {})) {
      if (demanded === true && !caps[bit as keyof SandboxProviderCapabilities]) {
        throw this.unsupported(
          `provider '${provider.name}' does not support '${bit}', which this request requires`,
        );
      }
    }
    if (!caps.spawnTty) {
      throw this.unsupported(
        `provider '${provider.name}' does not support spawnTty — every agent runtime on ` +
          'this platform needs a TTY (terminal session + runtime auth), so no sandbox can ' +
          'be created on it',
      );
    }
  }

  /** UNSUPPORTED_CAPABILITY through the SAME contract→HTTP table as provider errors (04 §4). */
  private unsupported(message: string): unknown {
    return this.mapProviderError(
      new SandboxProviderError(SandboxProviderErrorCode.UNSUPPORTED_CAPABILITY, message),
    );
  }

  /** Resolve + validate the project via the cross-context facade (maps errors). */
  private async resolveProject(projectId: string): Promise<ProjectRuntimeContext> {
    try {
      return await this.projectFacade.getRuntimeContextForTask(projectId);
    } catch (e) {
      if (e instanceof ProjectAccessError) {
        const status = e.code === 'PROJECT_NOT_FOUND' ? HttpStatus.NOT_FOUND : HttpStatus.CONFLICT;
        throw new HttpException({ code: e.code, message: e.message }, status);
      }
      throw e;
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

  /**
   * Tear down a sandbox. `force` (INTERNAL only — never exposed on the DELETE wire
   * DTO) SKIPS the graceful `provider.stop()` and goes straight to the force removal
   * (`provider.destroy` already does `remove({force:true})` — 04 §2.2). The credential
   * revoke coordinator (05 §4) escalates to `force` when a graceful teardown times out
   * so a wedged container can never block clearing a revoked credential's bindings.
   */
  async destroy(id: string, input: DestroySandboxInput & { force?: boolean } = {}): Promise<void> {
    const sandbox = await this.repo.findById(asSandboxId(id));
    if (!sandbox) throw new NotFoundException(`sandbox ${id} not found`);
    const provider = this.registry.get(sandbox.provider);
    const handle = this.handleOf(sandbox);
    const graceful = !(input.force ?? false);

    try {
      // Bring the aggregate to a state from which `destroying` is legal (23 I-SBX-1:
      // stopped|failed → destroying). `force` skips only the graceful `provider.stop()`
      // IO — the state walk itself is unchanged so the transition table stays honoured.
      if (sandbox.status === 'running' || sandbox.status === 'idle') {
        this.advance(sandbox, 'stopping', 'user');
        if (handle && graceful) await provider.stop(handle);
        this.advance(sandbox, 'stopped', 'user');
      } else if (sandbox.status === 'stopping') {
        // recover an interrupted graceful attempt (a prior teardown that timed out
        // inside provider.stop persisted `stopping` before we escalated to force).
        this.advance(sandbox, 'stopped', 'user');
      } else if (sandbox.status === 'starting') {
        this.advance(sandbox, 'failed', 'user'); // starting → failed → destroying
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
      ? {
          provider: sandbox.provider,
          providerSandboxId: sandbox.providerSandboxId,
          agentEndpointPort: sandbox.agentEndpointPort ?? undefined,
          agentAuthToken: sandbox.agentAuthToken ?? undefined,
        }
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

  /**
   * Map contract errors to HTTP (04 §4 interface mapping).
   *
   * `INSTALL_FAILED` / `IMAGE_CONTRACT_VIOLATION` are included even though their MAIN
   * exposure is not HTTP at all — both happen inside the provision workflow, long
   * after the caller got its 202, and reach the user as `failed` + `failure_reason` +
   * WS `sandbox.status_changed`. They are mapped anyway for two reasons 04 §4 states
   * explicitly: a future synchronous entry point (a retry-install endpoint) must have a
   * rule to follow, and 02 §6.2 forbids any error code without a mapping.
   */
  private mapProviderError(e: unknown): unknown {
    if (e instanceof HttpException) return e;
    if (e instanceof RuntimeInstallFailedError || e instanceof ImageContractViolationError) {
      return new HttpException(
        { code: e.code, message: e.message, retryable: e.retryable },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
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
