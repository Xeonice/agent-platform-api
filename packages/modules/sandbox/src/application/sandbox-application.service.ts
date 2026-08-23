import { HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
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
  RUNTIME_ADAPTER_REGISTRY,
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
  PROJECT_FACADE,
  ProjectAccessError,
  SandboxProviderError,
  SandboxProviderErrorCode,
  UnknownRuntimeError,
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
import { mapProviderErrorToHttp } from './provider-error.http';
import {
  INVALID_IMAGE_REFERENCE_CODE,
  UNKNOWN_PROVIDER_CODE,
  atDoor,
  doorRejection,
} from './door-rejection.http';
import { Sandbox } from '../domain/entities/sandbox.entity';
import type { SandboxStatus } from '../domain/value-objects/sandbox-status.vo';
import type { TriggeredBy } from '../domain/entities/state-transition.entity';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../domain/repositories/sandbox.repository';
import { SandboxMapper } from './dto/sandbox.mapper';

/** What the create door hands to the transaction once a request is admitted. */
interface AdmittedCreate {
  providerName: string;
  provider: SandboxProvider;
  imageRef: string;
  baselinePath: ProjectRuntimeContext['baselinePath'];
}

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
        headlessTask: p.capabilities.headlessTask,
      },
      isDefault: p.name === defaultProvider,
    }));
  }

  async create(input: CreateSandboxInput): Promise<SandboxDto> {
    const admitted = await this.admit(input);

    const headless = input.headless ?? false;
    const sandbox = Sandbox.create({
      id: asSandboxId(this.ids.next()),
      projectId: asProjectId(input.projectId),
      runtime: input.runtime,
      runtimeLabel: this.runtimeLabel(input.runtime),
      provider: admitted.providerName,
      imageRef: admitted.imageRef,
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
    void this.provision.runSafely(sandbox, admitted.provider, admitted.baselinePath);
    return dto;
  }

  /**
   * THE CREATE DOOR (04 §5 「创建前静态校验」) — every check that decides whether the
   * request is admissible AT ALL, and nothing else.
   *
   * ⚠️ IT IS ONE METHOD BECAUSE 「零副作用」 IS A POSITIONAL PROPERTY. Read the body:
   * it holds no `uow`, writes nothing, schedules nothing and never touches
   * `provider.create` — so 不进调度、不落库、不调 `provider.create` is true of every
   * rejection here by construction, not by promise. `atDoor` turns that structural fact
   * into `ErrorEnvelope.sideEffectFree` on the way out, which is why a door check added
   * to this method later is flagged correctly without its author doing anything (and
   * why a door check added OUTSIDE it would not be — see `door-rejection.http.ts`).
   *
   * The six rejections it can produce today, all of them 零副作用:
   *   `UNKNOWN_PROVIDER` 400 · `UNSUPPORTED_CAPABILITY` 409 · `UNKNOWN_RUNTIME` 400 ·
   *   `INVALID_IMAGE_REFERENCE` 400 · `PROJECT_NOT_FOUND` 404 · `PROJECT_NOT_READY` 409.
   */
  private admit(input: CreateSandboxInput): Promise<AdmittedCreate> {
    return atDoor(async () => {
      const providerName = input.provider ?? this.registry.defaultProvider;
      if (!this.registry.has(providerName)) {
        throw doorRejection(
          HttpStatus.BAD_REQUEST,
          UNKNOWN_PROVIDER_CODE,
          `unknown provider '${providerName}'`,
        );
      }
      const provider = this.registry.get(providerName);
      // capability mismatches are rejected HERE — before the project lookup, before a
      // row is written, before anything is scheduled.
      this.assertCapabilities(provider, input.require, input.headless ?? false);
      this.assertRuntimeRegistered(input.runtime);
      const imageRef = this.resolveImage(input.image);

      // validate the project + resolve its baseline AT CREATE time (S2, 26 §3 link①):
      // the facade runs Project.assertCanAcceptTask and throws ProjectAccessError,
      // which we surface as HTTP BEFORE any sandbox row is written.
      const projectCtx = await this.resolveProject(input.projectId);

      return { providerName, provider, imageRef, baselinePath: projectCtx.baselinePath };
    });
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
    //
    // ⚠️ `\s` ALONE DOES NOT SAY "control characters" — it covers tab/newline/space
    // and friends, but NUL, BEL and ESC are none of those. An image ref is
    // concatenated into a registry reference and echoed into logs, so an embedded
    // `\x1b[` is a terminal-escape injection into anything that renders them, and a
    // `\x00` truncates the ref for a C-string consumer. The comment promised this
    // check; now it is one.
    if (/[\s\p{Cc}]/u.test(ref)) {
      throw doorRejection(
        HttpStatus.BAD_REQUEST,
        INVALID_IMAGE_REFERENCE_CODE,
        `invalid image reference '${requested}'`,
      );
    }
    return ref;
  }

  /**
   * The runtime must EXIST in the registry — checked HERE, at the door, in the same
   * 段 as `assertCapabilities` and for the same reason (04 §5 「创建前静态校验」:
   * 不进调度、不落库、不调 `provider.create`).
   *
   * ⚠️ WHY THE TYPE SYSTEM CANNOT DO THIS AND SHOULD NOT TRY (14 §10). `runtime` is
   * `z.string().min(1)` on the wire because the adapter registry is an OPEN set —
   * `RuntimeAdapterRegistry` is keyed by a plain id, *not a closed enum* (04 §8), so a
   * third-party adapter can register at RUNTIME. Narrowing the contract to an enum
   * would delete that extension point; codegen therefore hands the frontend
   * `runtime: string`, and every literal it can spell type-checks. The measured
   * consequence was a frontend `S2_DEFAULT_RUNTIME = 'shell'` reaching a backend that
   * has only `codex` / `claude-code`: every sandbox created from that entry point died
   * — asynchronously, in provision, filed under `INSTALL_FAILED`, i.e. told the user
   * "the CLI failed to install" about a runtime that never existed.
   *
   * So the defence is a DOOR CHECK, not a type: same shape as the `unknown provider`
   * line a few statements up, because it is the same problem about the sibling
   * registry.
   *
   * ⚠️ IT THROWS THE TYPED CONTRACT ERROR, NOT A HAND-BUILT 400. `UnknownRuntimeError`
   * already IS this fact — it carries `UNKNOWN_RUNTIME` and `retryable:false`, and 04 §4's
   * one table already maps it to 400 (`mapProviderErrorToHttp`, applied by `atDoor`).
   * Restating it as `BadRequestException('unknown runtime …')` produced a body with
   * neither field, which the frontend discards as "not an envelope" — so the platform's
   * one precise sentence about this failure never reached the person who could act on it.
   */
  private assertRuntimeRegistered(runtimeId: string): void {
    if (!this.runtimes.has(runtimeId)) {
      throw new UnknownRuntimeError(runtimeId);
    }
  }

  /**
   * Human-facing runtime label for the fallback task name (P21-1 §9).
   *
   * The `has()` fallback is DEFENSIVE ONLY on the create path — `assertRuntimeRegistered`
   * has already refused an unregistered id by the time this runs. It is deliberately
   * kept rather than replaced by a bare `get()`: this reads as "no label ⇒ show the id",
   * which is a display decision, and it must never again be the place where "this
   * runtime does not exist" is silently absorbed.
   */
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
   *   ③ `headless: true` DERIVES a `headlessTask` requirement (04 §2.5): a headless
   *     Task's entire execution is the job plane plus the file plane, so a provider
   *     without them could accept the request and then have no way to run, stream or
   *     collect anything. `headlessTask` is deliberately not in `require` — restating
   *     an implication is the caller's job to get wrong, not the platform's.
   *
   * ⚠️ THIS BRANCH SHIPS WITH THE TWO PLANES, NOT BEFORE THEM (04 §2.6). Landing it
   * alone would turn today's working `headless:true` create into a 409, because the
   * provision workflow's step ⑤ simply returns for headless sandboxes.
   *
   * All three throw BEFORE scheduling, so `provider.create` is never reached.
   */
  private assertCapabilities(
    provider: SandboxProvider,
    require: RequiredCapabilities | undefined,
    headless: boolean,
  ): void {
    const caps = provider.capabilities;
    for (const [bit, demanded] of Object.entries(require ?? {})) {
      if (demanded === true && !caps[bit as keyof SandboxProviderCapabilities]) {
        throw this.unsupported(
          `provider '${provider.name}' does not support '${bit}', which this request requires`,
        );
      }
    }
    if (headless && !caps.headlessTask) {
      throw this.unsupported(
        `provider '${provider.name}' does not support 'headlessTask', which a headless ` +
          'Task requires — it has no job plane to run the agent in and no file plane to ' +
          'fetch its artifacts from (04 §2.6)',
      );
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

  /**
   * Resolve + validate the project via the cross-context facade (maps errors).
   *
   * ⚠️ THESE TWO ARE DOOR REJECTIONS TOO, AND THE ENVELOPE SAID SO ABOUT NEITHER.
   * `getRuntimeContextForTask` only READS (it runs `Project.assertCanAcceptTask`), so a
   * project that does not exist / is still cloning / failed to clone is refused with the
   * same 零副作用 guarantee as the two registry checks above — yet the body carried no
   * `retryable`, which makes it a non-envelope to the frontend exactly like the bare
   * 400s did. `retryable:false` for both, per `doorRejection`: a project has to BECOME
   * ready, and no number of identical re-sends of THIS request causes that.
   */
  private async resolveProject(projectId: string): Promise<ProjectRuntimeContext> {
    try {
      return await this.projectFacade.getRuntimeContextForTask(projectId);
    } catch (e) {
      if (e instanceof ProjectAccessError) {
        const status = e.code === 'PROJECT_NOT_FOUND' ? HttpStatus.NOT_FOUND : HttpStatus.CONFLICT;
        throw doorRejection(status, e.code, e.message);
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

  /** Map contract errors to HTTP through the ONE shared table (04 §4). */
  private mapProviderError(e: unknown): unknown {
    return mapProviderErrorToHttp(e);
  }
}
