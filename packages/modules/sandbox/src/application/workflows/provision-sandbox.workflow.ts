import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, EVENT_BUS, UNIT_OF_WORK } from '@platform/shared-kernel';
import type { Clock, EventBus, UnitOfWork } from '@platform/shared-kernel';
import {
  AGENT_SESSION_BOOTSTRAP,
  CREDENTIAL_FACADE,
  CredentialPreparationError,
  RUNTIME_ADAPTER_REGISTRY,
  RUNTIME_INSTALL_ORCHESTRATOR,
  INTERNAL_ERROR_CODE,
  SANDBOX_WORKSPACE_MOUNT,
  WORKSPACE_PREPARER,
  toExecFn,
} from '@platform/contracts';
import type {
  AgentSessionBootstrap,
  CredentialFacade,
  InjectableRuntimeCredential,
  ResolvedImageSpec,
  RuntimeAdapterRegistry,
  RuntimeInstallOrchestrator,
  SandboxExecFn,
  SandboxHandle,
  SandboxProvider,
  WorkspacePreparer,
  WorkspaceSource,
} from '@platform/contracts';
import type { Sandbox } from '../../domain/entities/sandbox.entity';
import type { SandboxStatus } from '../../domain/value-objects/sandbox-status.vo';
import type { TriggeredBy } from '../../domain/entities/state-transition.entity';
import { SANDBOX_REPOSITORY } from '../../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../../domain/repositories/sandbox.repository';

const DEFAULT_QUOTA = { cores: 1, ramMb: 512, diskMb: 1024 };

/**
 * Everything that happens AFTER the 202 (26 §1, 24 §1.3): the staged pipeline
 * `scheduling → preparing-workspace → creating → starting → running`, plus the
 * per-stage compensation. Each transition is its own SHORT transaction; the slow IO
 * (provider, workspace, exec) happens strictly BETWEEN transactions.
 *
 * The `starting` 段 is where a Task actually begins to run, in FIVE steps whose order
 * is pinned by physics rather than taste (03 §4.3):
 *
 *   ① provider.start()                       — must be first…
 *   ② in-sandbox agent readiness probe        — …because ③④⑤ all need a `SandboxExecFn`,
 *   ③ ensureRuntimeInstalled                     which derives from `spawn({tty:false})`
 *   ④ prepare → injectCredential → record        and therefore requires a RUNNING
 *   ⑤ bootstrapAgentSession                      instance (04 §2.3).
 *
 * ② is performed INSIDE `provider.start()` by both built-ins (the container reports
 * "running" long before the agent's HTTP server accepts connections), so it is not a
 * separate call here — the gate exists, it just lives one layer down.
 */
@Injectable()
export class ProvisionSandboxWorkflow {
  private readonly logger = new Logger('ProvisionSandboxWorkflow');

  constructor(
    @Inject(SANDBOX_REPOSITORY) private readonly repo: SandboxRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKSPACE_PREPARER) private readonly workspace: WorkspacePreparer,
    @Inject(RUNTIME_ADAPTER_REGISTRY) private readonly runtimes: RuntimeAdapterRegistry,
    @Inject(RUNTIME_INSTALL_ORCHESTRATOR) private readonly installs: RuntimeInstallOrchestrator,
    @Inject(CREDENTIAL_FACADE) private readonly credentials: CredentialFacade,
    @Inject(AGENT_SESSION_BOOTSTRAP) private readonly agentSessions: AgentSessionBootstrap,
  ) {}

  /** Background runner — never rejects into an unhandled promise. */
  async runSafely(
    sandbox: Sandbox,
    provider: SandboxProvider,
    source: WorkspaceSource,
  ): Promise<void> {
    try {
      await this.run(sandbox, provider, source);
    } catch (e) {
      // run() already marked `failed`, recorded the reason and tore down any orphan.
      this.logger.error(`provision failed for sandbox ${sandbox.id}: ${(e as Error).message}`);
    }
  }

  async run(sandbox: Sandbox, provider: SandboxProvider, source: WorkspaceSource): Promise<void> {
    // hoisted so the failure path can tear down a container that WAS created (e.g. a
    // later `start`/install failure) — otherwise it orphans (S1 audit P1-2).
    let handle: SandboxHandle | undefined;
    try {
      this.advance(sandbox, 'scheduling', 'scheduler');
      this.advance(sandbox, 'preparing-workspace', 'scheduler');
      // `source.branch` (if any) was already checked against the baseline's refs at the
      // create door, so the checkout inside `prepare` is a local operation expected to
      // succeed; a failure here is a real fault and lands as WORKSPACE_PREPARE_FAILED.
      const ws = await this.workspace.prepare(sandbox.id, source);

      this.advance(sandbox, 'creating', 'scheduler');
      const image = this.imageSpecOf(sandbox);
      // env-form credentials (claude's `CLAUDE_CODE_OAUTH_TOKEN`, an api-key) can ONLY
      // be delivered at instance creation: a per-call `env` would be visible in `ps`
      // inside the sandbox (04 §2.3★ 第 2 条), and an already-started process cannot
      // have env added. So the credential is resolved once here and REUSED for the
      // post-start `injectCredential` — resolving it twice would decrypt twice for no
      // gain. Credentials are written LAST into the env map so a same-named user
      // variable can never win (05 §4.1 "凭证永远赢，靠顺序而非黑名单").
      const credential = await this.prepareCredential(sandbox);
      try {
        handle = await provider.create({
          sandboxId: sandbox.id,
          quota: DEFAULT_QUOTA,
          image,
          env: { ...(credential?.env ?? {}) },
          volumes: [
            {
              source: ws.hostPath,
              target: SANDBOX_WORKSPACE_MOUNT,
              mode: 'rw',
              kind: 'host-path',
            },
          ],
          labels: { 'platform.sandboxId': sandbox.id },
        });
        sandbox.bindRuntime({
          providerSandboxId: handle.providerSandboxId,
          workspacePath: ws.hostPath,
          // persist any provider runtime binding (boxlite's forwarded agent port,
          // and the agent bearer token both providers mint) so a backend restart can
          // rebuild the handle and still reach the instance.
          agentEndpointPort: handle.agentEndpointPort ?? null,
          agentAuthToken: handle.agentAuthToken ?? null,
        });
        this.persist(sandbox); // save handle (no new transition/event)

        this.advance(sandbox, 'starting', 'scheduler');
        await this.runStartingSteps(sandbox, provider, handle, image, credential);
      } finally {
        credential?.zeroize();
      }

      this.advance(sandbox, 'running', 'scheduler');
    } catch (e) {
      this.compensate(sandbox, e);
      if (handle) await provider.destroy(handle).catch(() => undefined);
      await this.workspace.cleanup(sandbox.id, { keep: false }).catch(() => undefined);
      throw e;
    }
  }

  /**
   * `stopped → starting` (I-SBX-9): bring a stopped sandbox back up. It deliberately
   * does NOT pass through `preparing-workspace` — the workspace directory is still
   * there — and does not re-create the instance. What it DOES re-run is the whole
   * `starting` 段, because a restarted instance is a fresh process tree: the CLI must
   * be re-verified, the credential re-injected, and a NEW agent session started.
   *
   * P22 §2 already promises the user that a restart is "a new agent session, context
   * not preserved" — which is also why the initial instruction is not replayed here
   * (its `consumedAt` is already set).
   */
  async restart(sandbox: Sandbox, provider: SandboxProvider): Promise<void> {
    const handle = this.handleOf(sandbox);
    try {
      this.advance(sandbox, 'starting', 'scheduler');
      const credential = await this.prepareCredential(sandbox);
      try {
        await this.runStartingSteps(
          sandbox,
          provider,
          handle,
          this.imageSpecOf(sandbox),
          credential,
        );
      } finally {
        credential?.zeroize();
      }
      this.advance(sandbox, 'running', 'scheduler');
    } catch (e) {
      this.compensate(sandbox, e);
      throw e;
    }
  }

  /**
   * Steps ① ② ③ ④ ⑤ of 03 §4.3 — the ONE place their order is expressed, shared by
   * first provision and restart so the two can never drift apart.
   */
  private async runStartingSteps(
    sandbox: Sandbox,
    provider: SandboxProvider,
    handle: SandboxHandle,
    image: ResolvedImageSpec,
    credential: InjectableRuntimeCredential | null,
  ): Promise<void> {
    // ① + ② — start, and gate on in-sandbox agent readiness (inside `start`).
    await provider.start(handle);
    const exec = toExecFn(provider, handle);

    // ③ install the runtime CLI. Deliberately BEFORE ④: there is no point injecting
    // a credential for a CLI that is not there yet, and both steps need `exec`.
    await this.installs.ensureInstalled({
      sandboxId: sandbox.id,
      runtimeId: sandbox.runtime,
      image,
      exec,
    });

    // ③.5 落 runtime 启动前需要的文件。**刻意排在 ④ 之前、且与 ④ 无关**:
    // ④ 只在有凭证时才跑,而这一步要处理的闸门(codex 的目录信任提示)在**没有凭证时
    // 照样拦**——那时 agent 会停在提示上,连"我没登录"都报不出来。
    await this.seedStartupFiles(sandbox, exec);

    // ④ materialise the credential inside the sandbox.
    await this.injectCredential(sandbox, credential, exec);

    // ⑤ start the agent session — this is what makes "the agent starts working the
    // moment the task starts" true for a user who closed the browser, and for MCP
    // `create_sandbox`, which has no terminal at all (裁决 D-15).
    await this.bootstrapAgentSession(sandbox, exec);
  }

  private handleOf(sandbox: Sandbox): SandboxHandle {
    if (!sandbox.providerSandboxId) {
      throw new Error(`sandbox ${sandbox.id} has no provider handle to restart`);
    }
    return {
      provider: sandbox.provider,
      providerSandboxId: sandbox.providerSandboxId,
      agentEndpointPort: sandbox.agentEndpointPort ?? undefined,
      agentAuthToken: sandbox.agentAuthToken ?? undefined,
    };
  }

  /**
   * The image the sandbox actually runs. `digest` is a placeholder until the image
   * context lands (04 §7 IS-01 wants a real digest, but there is no `ImageSpecProvider`
   * yet — 04 §8 marks the registry ⏳).
   */
  private imageSpecOf(sandbox: Sandbox): ResolvedImageSpec {
    return { ref: sandbox.imageRef, digest: 'sha256:unresolved' };
  }

  /**
   * Resolve the runtime credential for this sandbox, or `null` when none is configured.
   *
   * A MISSING credential is NOT a provisioning failure: a user may legitimately create
   * a task before authorising a runtime, and the agent itself will say it is not logged
   * in. What must never happen is a SILENT half-state, so it is logged loudly.
   */
  private async prepareCredential(sandbox: Sandbox): Promise<InjectableRuntimeCredential | null> {
    try {
      return await this.credentials.prepareRuntimeCredential(sandbox.runtime);
    } catch (e) {
      if (e instanceof CredentialPreparationError) {
        this.logger.warn(
          `sandbox ${sandbox.id}: no usable '${sandbox.runtime}' credential (${e.code}); ` +
            'the agent will start UNAUTHENTICATED',
        );
        return null;
      }
      throw e;
    }
  }

  /**
   * Step ④ (05 §4.3): the adapter writes the credential into the LIVE sandbox and the
   * injection is recorded in the ledger that the revoke coordinator reads (23 §8.4).
   *
   * ORDER MATTERS AND IS TESTED (T-SBX-31): `exec` derives from `spawn({tty:false})`,
   * so this can only run after `provider.start()`. The older design had injection
   * before `start` — which cannot work at all.
   */
  /**
   * 可选钩子:绝大多数 runtime 不需要落任何文件,没实现即跳过(与本钩子出现之前一致)。
   * 失败**不阻断 provision**:落不下这份文件顶多是 agent 停在一个交互提示上,
   * 而把整个 Task 判死显然更糟——记一条 WARN,与凭证缺席那条同一处置。
   */
  private async seedStartupFiles(sandbox: Sandbox, exec: SandboxExecFn): Promise<void> {
    const adapter = this.runtimes.get(sandbox.runtime);
    if (!adapter.seedStartupFiles) return;
    try {
      await adapter.seedStartupFiles({ workdir: SANDBOX_WORKSPACE_MOUNT }, exec);
    } catch (e) {
      this.logger.warn(
        `sandbox ${sandbox.id}: seeding '${sandbox.runtime}' startup files failed ` +
          `(${(e as Error).message}); the agent may stop at an interactive prompt`,
      );
    }
  }

  private async injectCredential(
    sandbox: Sandbox,
    credential: InjectableRuntimeCredential | null,
    exec: SandboxExecFn,
  ): Promise<void> {
    if (!credential) return;
    const adapter = this.runtimes.get(sandbox.runtime);
    await adapter.injectCredential(credential, exec);
    await this.credentials.recordRuntimeInjection(sandbox.runtime, sandbox.id);
  }

  /**
   * Step ⑤. Only for interactive tasks: a `headless:true` Task's execution path is a
   * later slice (TASK-LAUNCH-DECISIONS T-4), and starting an interactive agent for it
   * would be inventing behaviour nobody asked for.
   *
   * `initial_prompt_consumed_at` is stamped ONLY after the session really started, and
   * only when the prompt was actually carried — so a failed bootstrap can be retried
   * without losing the user's instruction, and a restart (which re-runs provision,
   * I-SBX-9) does not REPLAY it onto files the previous run already changed.
   */
  private async bootstrapAgentSession(sandbox: Sandbox, exec: SandboxExecFn): Promise<void> {
    if (sandbox.headless) return;
    const pending = sandbox.initialTask.isPending;
    const result = await this.agentSessions.bootstrapAgentSession({
      sandboxId: sandbox.id,
      runtimeId: sandbox.runtime,
      initialPrompt: pending ? sandbox.initialTask.prompt : undefined,
      workdir: SANDBOX_WORKSPACE_MOUNT,
      exec,
    });
    if (result.promptConsumed) {
      sandbox.consumeInitialTask(this.clock.now());
      this.persist(sandbox);
    }
  }

  /**
   * `starting`/`creating`/`preparing-workspace` all fail the same way from the state
   * machine's point of view: land `failed` with a HUMAN-READABLE reason (13 §2.1.1
   * `failure_reason`; the frontend renders that sentence per P22 §1, not the code).
   */
  private compensate(sandbox: Sandbox, error: unknown): void {
    try {
      sandbox.failWith(failureOf(error), 'scheduler', this.clock.now());
      this.persist(sandbox);
    } catch {
      // best-effort marking; a terminal state legitimately refuses the move
    }
  }

  private advance(sandbox: Sandbox, to: SandboxStatus, by: TriggeredBy): void {
    sandbox.transitionTo(to, by, this.clock.now());
    this.persist(sandbox);
  }

  private persist(sandbox: Sandbox): void {
    this.uow.run((tx) => {
      this.repo.saveSync(tx, sandbox);
      this.events.publishInTx(tx, sandbox.pullEvents());
    });
  }
}

/**
 * Split a thrown error into the two halves the failure record stores (13 §2.1.1).
 *
 * Every error the `starting` 段 can raise already carries a `code` from the 04 §4
 * closed set — `SandboxProviderError` (IMAGE_PULL_FAILED / TIMEOUT / …),
 * `RuntimeInstallFailedError` (INSTALL_FAILED), `ImageContractViolationError`
 * (IMAGE_CONTRACT_VIOLATION). Anything without one is `INTERNAL` rather than a bare
 * message: 02 §6.2 forbids a failure with no code, because the frontend would then
 * have nothing to key its P22 §1 sentence on and would fall back to generic copy.
 *
 * The message is kept as DETAIL only — deliberately not concatenated with the code.
 * Prose gets reworded; a UI that had to parse the code back out of it would break.
 */
function failureOf(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const raw =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return { code: typeof raw === 'string' && raw !== '' ? raw : INTERNAL_ERROR_CODE, message };
}
