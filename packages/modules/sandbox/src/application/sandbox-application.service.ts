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
  IMAGE_FACADE,
  ImageAccessError,
  ProjectAccessError,
  SandboxProviderError,
  SandboxProviderErrorCode,
  UnknownRuntimeError,
  toExecFn,
} from '@platform/contracts';
import type {
  CreateSandboxInput,
  DestroySandboxInput,
  ExecInSandboxInput,
  ExecResult,
  ProviderDto,
  RequiredCapabilities,
  RuntimeAdapterRegistry,
  SandboxDto,
  ProviderRegistry,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxHandle,
  WorkspacePreparer,
  ProjectAccessErrorCode,
  ProjectFacade,
  ProjectRuntimeContext,
  ImageFacade,
  WorkspaceSource,
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

/**
 * How long a `POST /api/sandboxes/:id/exec` command may run.
 *
 * ⚠️ IT IS A PLATFORM CONSTANT BECAUSE THE WIRE CONTRACT HAS NO FIELD FOR IT
 * (10 §7.3 `ExecRequest { command }`), and that is the right shape: the budget being
 * spent is a held-open HTTP connection, which is the platform's resource, not the
 * caller's. Anything that legitimately runs longer is a headless Task
 * (`POST …/runtimes/:rt/tasks`, 30/60/120/240 MINUTES) or an interactive terminal —
 * both of which exist precisely so this endpoint does not have to grow a timeout knob.
 *
 * 60s rather than something tighter: the platform's own one-shot execs through the same
 * `toExecFn` include package probes and file seeding on a cold sandbox, and a limit that
 * cannot fit those would make the endpoint useless for the diagnostics people reach for
 * it to run. It is NOT sized for installs — a cold runtime-CLI install measured 753s and
 * has its own orchestrator, which is why it does not come through here.
 */
const EXEC_TIMEOUT_MS = 60_000;

/**
 * HTTP status for each way the project facade can refuse (10 §6.8 「门口拒绝」).
 * A table rather than a ternary: adding a code to `ProjectAccessErrorCode` now fails
 * TYPECHECK here until its status is decided, instead of silently inheriting whatever
 * the `else` branch happened to be — which is how `BRANCH_NOT_FOUND` would otherwise
 * have shipped as a 409 「项目状态不对」 for what is a bad ARGUMENT.
 */
const PROJECT_ACCESS_STATUS: Record<ProjectAccessErrorCode, HttpStatus> = {
  PROJECT_NOT_FOUND: HttpStatus.NOT_FOUND,
  PROJECT_NOT_READY: HttpStatus.CONFLICT,
  // 400, alongside `UNKNOWN_PROVIDER` / `UNKNOWN_RUNTIME`: the request named something
  // that is not in the set the platform offers. The project itself is perfectly fine.
  BRANCH_NOT_FOUND: HttpStatus.BAD_REQUEST,
};

/** What the create door hands to the transaction once a request is admitted. */
interface AdmittedCreate {
  providerName: string;
  provider: SandboxProvider;
  imageRef: string;
  /** where the workspace comes from, and which branch it must end up on (03 §7.2★). */
  workspaceSource: WorkspaceSource;
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
    @Inject(IMAGE_FACADE) private readonly imageFacade: ImageFacade,
    @Inject(RUNTIME_ADAPTER_REGISTRY) private readonly runtimes: RuntimeAdapterRegistry,
    private readonly provision: ProvisionSandboxWorkflow,
  ) {}

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
    // MUST NOT block on provision→start→readiness — boxlite cold-pull alone
    // is ~220s, a cold runtime-CLI install was measured at 753s, and even a WARM
    // micro-VM takes 3.2s to boot before its first exec (实测 2026-08-26). Snapshot the
    // `pending` DTO NOW (before provision runs — it advances the aggregate
    // synchronously up to its first await), return it immediately, and let provision
    // drive the state machine in the background (each transition persists + publishes
    // a SandboxStateChanged event for the WS relay). Failures land `failed`.
    const dto = SandboxMapper.toDto(sandbox, false);
    void this.provision.runSafely(sandbox, admitted.provider, admitted.workspaceSource);
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
   * The seven rejections it can produce today, all of them 零副作用:
   *   `UNKNOWN_PROVIDER` 400 · `UNSUPPORTED_CAPABILITY` 409 · `UNKNOWN_RUNTIME` 400 ·
   *   `INVALID_IMAGE_REFERENCE` 400 · `PROJECT_NOT_FOUND` 404 · `PROJECT_NOT_READY` 409 ·
   *   `BRANCH_NOT_FOUND` 400.
   *
   * ⚠️ `INVALID_IMAGE_REFERENCE` NOW COVERS THREE FACTS, NOT ONE (04 §7 时刻③): a
   * malformed reference, an image that was never registered, and a registered version
   * that is either retired (I-IMG-3) or judged `invalid` (I-IMG-2). One code because
   * the user does the same thing about all three — pick a different image, or make
   * this one selectable — and because a NEW retryable-looking code in this method
   * would have to justify itself against the paragraph above.
   *
   * ⚠️ `BRANCH_NOT_FOUND` IS THE PROOF THAT THE POSITIONAL RULE WORKS. It was added by
   * extending the project lookup below with one more argument — nobody wrote
   * `sideEffectFree` anywhere — and it is stamped correctly because it is thrown from
   * inside this region. 10 §6.8's 「门口拒绝」 table still lists six rows; this is the
   * seventh, and it obeys the same 「retryable:false」 rule for the same reason.
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
      // ⚠️ **provider 必须先定下来**：两档的预制镜像不再是同一张（ADR 决策 C），
      // 所以「不给镜像时用哪一张」与「这张镜像跑不跑得了」都取决于它。
      const imageRef = await this.resolveImage(input.image, provider.name);

      // validate the project + resolve its baseline AT CREATE time (S2, 26 §3 link①):
      // the facade runs Project.assertCanAcceptTask and throws ProjectAccessError,
      // which we surface as HTTP BEFORE any sandbox row is written. `branch` is
      // validated in the SAME call — against the baseline's local refs (03 §7.2★).
      const projectCtx = await this.resolveProject(input.projectId, input.branch);

      return {
        providerName,
        provider,
        imageRef,
        workspaceSource: { baselinePath: projectCtx.baselinePath, branch: projectCtx.branch },
      };
    });
  }

  /**
   * The image to run — 04 §7 时刻③, the create door's image half.
   *
   * TWO CHECKS, IN THIS ORDER, AND BOTH BELONG AT THE DOOR:
   *
   *   ① SHAPE. Whitespace / control characters in a reference would flow into a
   *      container-runtime call. ⚠️ `\s` ALONE DOES NOT SAY 「control characters」 —
   *      it covers tab/newline/space and friends, but NUL, BEL and ESC are none of
   *      those. The reference is concatenated into a registry coordinate and echoed
   *      into logs, so an embedded `\x1b[` is a terminal-escape injection into
   *      anything that renders them, and a `\x00` truncates it for a C-string
   *      consumer.
   *
   *   ② CATALOGUE. The image must be a REGISTERED manifest that is `is_active`
   *      (I-IMG-3) and not `invalid` (I-IMG-2). What lands in `sandboxes.image_ref`
   *      is that manifest's ID, and the digest frozen at registration travels with
   *      it — which is the only reason step ④ can pull `ref@digest` at all.
   *
   * ⚠️ CHECK ② READS THE DATABASE AND NEVER THE REGISTRY. This is the single most
   * inverted-if-you-are-not-careful step in the whole image design (04 §7). Calling
   * `resolve()` here would look natural and would introduce `REGISTRY_UNREACHABLE`
   * (502, retryable:true) into a door that answers 「this request, as written, is not
   * accepted」 — turning 「门口拒绝一律 retryable:false」 from a structural property
   * back into a per-case judgement. A tag that was re-pushed is therefore discovered
   * only by an explicit re-validate, and that is the intended trade: a coordinate
   * migration should be a visible action, not an unnoticed drift.
   *
   * ⚠️ REFUSING AN UNREGISTERED COORDINATE IS THE BREAKING HALF OF THIS SLICE. Before
   * it, any string was accepted and `provision` pulled whatever the tag pointed at
   * that second. Accepting one now would mean a sandbox row with no manifest to join,
   * i.e. no digest — the placeholder, back again, through the one door that was
   * supposed to have closed it.
   */
  private async resolveImage(requested: string | undefined, provider: string): Promise<string> {
    const ref = (requested ?? '').trim();
    if (ref !== '' && /[\s\p{Cc}]/u.test(ref)) {
      throw doorRejection(
        HttpStatus.BAD_REQUEST,
        INVALID_IMAGE_REFERENCE_CODE,
        `invalid image reference '${requested}'`,
      );
    }
    try {
      const selected = await this.imageFacade.resolveForTask(
        ref === '' ? undefined : ref,
        provider,
      );
      return selected.manifestId;
    } catch (e) {
      if (e instanceof ImageAccessError) {
        // 400 alongside `UNKNOWN_PROVIDER` / `UNKNOWN_RUNTIME`: the request named
        // something outside the set the platform offers. `retryable:false` and
        // `sideEffectFree:true` are both earned by POSITION — this runs inside
        // `admit`'s `atDoor` region, which holds no `uow` and calls nothing.
        //
        // ⚠️ **码要透传，不能在这里钉死一个。** 原本这里硬写 `INVALID_IMAGE_REFERENCE`,
        // 于是「全新部署、一张镜像都没注册」也报「你的镜像地址里有空白或控制字符」——
        // 而用户什么都没填。facade 分了三个码正是为了让它们拿到不同的出路
        // （改地址 / 去镜像管理 / 换一档），在出口合并回一个等于把那次区分抹掉。
        // ⚠️ 第三个码 `IMAGE_PROVIDER_MISMATCH` 尤其不能并进前两个：它的出路
        // （换 provider 或换一张这一档的镜像）在另外两条建议下做**都没有用**。
        throw doorRejection(HttpStatus.BAD_REQUEST, e.code, e.message);
      }
      throw e;
    }
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
   * ⚠️ THESE ARE DOOR REJECTIONS TOO, AND THE ENVELOPE SAID SO ABOUT NONE OF THEM.
   * `getRuntimeContextForTask` only READS (it runs `Project.assertCanAcceptTask`), so a
   * project that does not exist / is still cloning / failed to clone is refused with the
   * same 零副作用 guarantee as the two registry checks above — yet the body carried no
   * `retryable`, which makes it a non-envelope to the frontend exactly like the bare
   * 400s did. `retryable:false` for both, per `doorRejection`: a project has to BECOME
   * ready, and no number of identical re-sends of THIS request causes that. The same
   * holds for `BRANCH_NOT_FOUND`: the caller must pick a branch that exists.
   */
  private async resolveProject(projectId: string, branch?: string): Promise<ProjectRuntimeContext> {
    try {
      return await this.projectFacade.getRuntimeContextForTask(projectId, branch);
    } catch (e) {
      if (e instanceof ProjectAccessError) {
        throw doorRejection(PROJECT_ACCESS_STATUS[e.code], e.code, e.message);
      }
      throw e;
    }
  }

  async get(id: string): Promise<SandboxDto> {
    const sandbox = await this.repo.findById(asSandboxId(id));
    if (!sandbox) throw new NotFoundException(`sandbox ${id} not found`);
    return SandboxMapper.toDto(sandbox, false);
  }

  /**
   * `POST /api/sandboxes/:id/start` (27 §2) — bring a STOPPED sandbox back up.
   *
   * ⚠️ IT IS ASYNCHRONOUS FOR THE SAME REASON `create` IS, AND THE SHAPE IS COPIED
   * DELIBERATELY. A restart re-runs the whole `starting` 段 (I-SBX-9: it skips
   * `preparing-workspace` because the workspace directory is still there, but the
   * instance is a fresh process tree — CLI re-verified, credential re-injected, a NEW
   * agent session started). The measured cost of that段 is not a request budget: a
   * cold image store took 190529ms just to stage the rootfs. So the response is the
   * aggregate as it stands the moment the platform has ACCEPTED the start, and the
   * progress arrives on WS `sandbox.status_changed`.
   *
   * ⚠️ THE RETURNED DTO SAYS `starting`, NOT `stopped`. `restart()` performs its first
   * transition synchronously (it persists + publishes before its first `await`), so
   * mapping AFTER kicking it off reports what actually happened rather than the state
   * the request arrived in. `create` relies on exactly the same property in the other
   * direction (it snapshots `pending` BEFORE calling provision), and a test pins it —
   * if that ever stops holding, this endpoint would start claiming a start it had not
   * begun.
   *
   * The two rejections, both 409 `INVALID_STATE` (10 §6.8 类 C: "此刻不行"):
   *   ① the status is not `stopped` — I-SBX-1's table has exactly one edge INTO
   *     `starting` from a resting state, and honouring the table here rather than
   *     letting `transitionTo` throw deep inside the background workflow is what makes
   *     the refusal reach the CALLER instead of a log line;
   *   ② there is no provider handle to start (I-SBX-3's contrapositive). Without this
   *     the background restart dies on `handleOf`'s bare `Error`, `runSafely`'s sibling
   *     swallows it, and the caller is told the sandbox is starting when nothing is.
   */
  async start(id: string): Promise<SandboxDto> {
    const sandbox = await this.repo.findById(asSandboxId(id));
    if (!sandbox) throw new NotFoundException(`sandbox ${id} not found`);
    if (sandbox.status !== 'stopped') {
      throw this.invalidState(
        `sandbox ${id} is '${sandbox.status}'; only a 'stopped' sandbox can be started ` +
          '(I-SBX-1). A failed one has to be destroyed and re-created.',
      );
    }
    if (!sandbox.providerSandboxId) {
      throw this.invalidState(
        `sandbox ${id} has no provider instance to start — it never reached the point ` +
          'where one was created, so there is nothing to bring back up (I-SBX-3).',
      );
    }
    const provider = this.registry.get(sandbox.provider);
    // advances to `starting` synchronously, then runs the 段 in the background.
    void this.provision.restartSafely(sandbox, provider);
    return SandboxMapper.toDto(sandbox, false);
  }

  /**
   * `POST /api/sandboxes/:id/stop` (27 §2) — graceful shutdown, instance kept.
   *
   * ⚠️ THIS ONE IS SYNCHRONOUS, AND THE ASYMMETRY WITH `start` IS THE POINT. Stopping
   * is one `provider.stop()` call — no image staging, no CLI install, no agent
   * bootstrap — which is why `destroy` (which walks the same `running → stopping →
   * stopped` edge inline) has always awaited it too. Returning early here would mean
   * inventing a second async path for the cheap half of the pair.
   *
   * ⚠️ IT DOES NOT DESTROY ANYTHING. The workspace directory, the instance and the
   * `providerSandboxId` all survive — that is what makes `start` above possible. What
   * does NOT survive is the agent's conversation: `stopped → start` is a NEW session
   * (P22 §2), which is why the UI has to say so rather than calling it "resume".
   *
   * The failure path mirrors `destroy`: mark `failed` best-effort so a wedged instance
   * does not sit in `stopping` forever, then surface the provider's own code (04 §4).
   */
  async stop(id: string): Promise<SandboxDto> {
    const sandbox = await this.repo.findById(asSandboxId(id));
    if (!sandbox) throw new NotFoundException(`sandbox ${id} not found`);
    if (sandbox.status !== 'running' && sandbox.status !== 'idle') {
      throw this.invalidState(
        `sandbox ${id} is '${sandbox.status}'; only a 'running' or 'idle' sandbox can be ` +
          'stopped (I-SBX-1).',
      );
    }
    const provider = this.registry.get(sandbox.provider);
    const handle = this.handleOf(sandbox);
    try {
      this.advance(sandbox, 'stopping', 'user');
      if (handle) await provider.stop(handle);
      this.advance(sandbox, 'stopped', 'user');
    } catch (e) {
      this.tryAdvance(sandbox, 'failed', 'user');
      throw this.mapProviderError(e);
    }
    return SandboxMapper.toDto(sandbox, false);
  }

  /**
   * `POST /api/sandboxes/:id/exec` (27 §2) — ONE non-interactive command.
   *
   * ⚠️ THE INTERACTIVE PATH IS NOT THIS ONE (27 §2, 06). A TTY session is WS
   * `/terminal`; a long agent run is `POST …/runtimes/:rt/tasks`. What is left for this
   * endpoint is the thing neither of those does well: "run this, tell me what it
   * printed and whether it worked" inside a request/response.
   *
   * ⚠️ `running` / `idle` ONLY (I-SBX-3). The exec derives from `spawn({tty:false})`,
   * which needs a STARTED instance (04 §2.3) — that is physics, not policy. Refusing
   * `starting` too is a judgement on top of it: a command sent while the CLI install is
   * still running would race the very step that makes the sandbox usable.
   *
   * ⚠️ THE DEADLINE IS ENFORCED TWICE, ON PURPOSE. `timeoutMs` goes to the provider so
   * the process is really killed INSIDE the sandbox (both built-ins implement it
   * natively — boxlite wraps in `timeout(1)`, aio passes `hard_timeout`); the
   * platform-side race is what guarantees the HTTP request ends, because a provider
   * that silently ignores `timeoutMs` would otherwise hold the connection until
   * something else gave up. Only the second one can produce `TIMEOUT`, and 27 §2 lists
   * it as an outcome of this capability, so it needs a producer that does not depend on
   * a provider being well-behaved.
   */
  async exec(id: string, input: ExecInSandboxInput): Promise<ExecResult> {
    const sandbox = await this.repo.findById(asSandboxId(id));
    if (!sandbox) throw new NotFoundException(`sandbox ${id} not found`);
    const handle = this.handleOf(sandbox);
    if ((sandbox.status !== 'running' && sandbox.status !== 'idle') || !handle) {
      throw this.invalidState(
        `sandbox ${id} is '${sandbox.status}'; a command can only be executed in a ` +
          "'running' or 'idle' sandbox (I-SBX-3).",
      );
    }
    const provider = this.registry.get(sandbox.provider);
    const exec = toExecFn(provider, handle);
    try {
      // `sh -c` so the caller's shell syntax (pipes, redirects, `&&`) means what it
      // reads as — the same form the platform's own probes use (install-plan.util).
      return await this.withDeadline(
        exec(['sh', '-c', input.command], { timeoutMs: EXEC_TIMEOUT_MS }),
        id,
      );
    } catch (e) {
      throw this.mapProviderError(e);
    }
  }

  /**
   * Reject with `TIMEOUT` if the exec has not settled within the budget.
   *
   * ⚠️ The loser of the race is NOT cancelled here, and it must not be: the process is
   * already being killed sandbox-side by `ProcessSpec.timeoutMs`, and the only thing
   * this side still holds is a promise whose result nobody reads. Adding an abort here
   * would mean a second, platform-side kill path for the same process.
   */
  private async withDeadline(work: Promise<ExecResult>, id: string): Promise<ExecResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new SandboxProviderError(
              SandboxProviderErrorCode.TIMEOUT,
              `command in sandbox ${id} did not finish within ${EXEC_TIMEOUT_MS / 1000}s`,
              undefined,
              true,
            ),
          ),
        EXEC_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 409 `INVALID_STATE` through the SAME contract→HTTP table as provider errors (04 §4). */
  private invalidState(message: string): unknown {
    return this.mapProviderError(
      new SandboxProviderError(SandboxProviderErrorCode.INVALID_STATE, message),
    );
  }

  /**
   * List sandboxes; `projectId` 缺省 = **全部项目**（工作台左侧任务树要的就是这个）。
   *
   * ★ 2026-08 修正：此前是 `if (!projectId) return [];` —— 不带过滤直接回空。
   * 前端工作台发的正是裸 `GET /api/sandboxes`，于是树里永远 0 个任务，而计数走的是
   * `ProjectDto.taskCount`（另一条路，来自 countActiveByProject）⇒ 出现"计数是 1 但
   * 展开一条都没有"的割裂。控制器自己的 summary 写的也是 "optionally filtered"。
   *
   * ⚠️ **`destroyed` 必须排除**，因为 `taskCount` 走的 `countActiveByProject` 就排除了它。
   * 两条路径共用这一处过滤，谁改都得一起改——不然计数与列表又会各说各话。
   */
  async list(projectId?: string): Promise<SandboxDto[]> {
    const sandboxes = projectId
      ? await this.repo.findByProject(asProjectId(projectId))
      : await this.repo.findAll();
    return sandboxes
      .filter((s) => s.status !== 'destroyed')
      .map((s) => SandboxMapper.toDto(s, false));
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
          providerState: sandbox.providerState ?? undefined,
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
