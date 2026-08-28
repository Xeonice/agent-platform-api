import { Inject, Injectable, Logger } from '@nestjs/common';
import { builtinImageRef, CLOCK, EVENT_BUS, UNIT_OF_WORK } from '@platform/shared-kernel';
import type { Clock, EventBus, UnitOfWork } from '@platform/shared-kernel';
import {
  AGENT_SESSION_BOOTSTRAP,
  AUDIT_RECORDER,
  CREDENTIAL_FACADE,
  CredentialPreparationError,
  RUNTIME_ADAPTER_REGISTRY,
  RUNTIME_INSTALL_ORCHESTRATOR,
  SANDBOX_EVENT_BROADCASTER,
  IMAGE_FACADE,
  INTERNAL_ERROR_CODE,
  isSandboxFailureCode,
  SANDBOX_WORKSPACE_MOUNT,
  WORKSPACE_PREPARER,
  toExecFn,
} from '@platform/contracts';
import type {
  AgentSessionBootstrap,
  AuditRecorder,
  CredentialFacade,
  ImageFacade,
  InjectableRuntimeCredential,
  ResolvedImageSpec,
  RuntimeAdapterRegistry,
  RuntimeInstallOrchestrator,
  SandboxEventBroadcaster,
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
    @Inject(IMAGE_FACADE) private readonly images: ImageFacade,
    /**
     * 审计流的**写入口 ②**（13 §2.8.2）。provision 的阶段耗时与失败那一刻都只有这里
     * 知道 —— 聚合在失败时压根不 publish 领域事件，projector 收不到任何东西。
     */
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    /**
     * `sandbox.instance_progress` 的出口。**不经领域事件、不进 Outbox** —— 与
     * `CloneProjectWorkflow` 推 `project.clone_progress` 同款：这两条都是「一段长 IO
     * 正在进行」的进度播报，不是聚合状态的变化，硬造一个领域事件只会让状态机里多出
     * 一次并不存在的转移（这正是 10 §7.4 不让它挤进 `status_changed` 的同一条理由）。
     */
    @Inject(SANDBOX_EVENT_BROADCASTER) private readonly broadcaster: SandboxEventBroadcaster,
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
    // ── 阶段计时（03 §7.8 `sandbox.provision.stage`）────────────────────────────
    // 「启动 237s→4s 无历史可比」是这几行存在的全部理由：状态流转本身已经在
    // `sandbox_state_transitions` 里，缺的是**每一段花了多久**。
    const provisionStartedAt = this.clock.now().getTime();
    // 当前跑到哪一段 —— 失败时用它给那条 outcome:'failed' 的审计定位。
    let stage = 'scheduling';
    let stageStartedAt = provisionStartedAt;
    // 当前阶段除耗时之外**还能说清什么**。⚠️ 它必须在 `enter` 时清空：上一段的
    // 解释挂到下一段上,比不解释更糟 —— 读的人会拿它当这一段的成因。
    let stageDetail: Record<string, unknown> = {};
    const enter = (name: string): void => {
      stage = name;
      stageStartedAt = this.clock.now().getTime();
      stageDetail = {};
    };
    const done = (): void =>
      this.recordStage(sandbox, stage, stageStartedAt, 'ok', undefined, stageDetail);
    try {
      this.advance(sandbox, 'scheduling', 'scheduler');
      this.advance(sandbox, 'preparing-workspace', 'scheduler');
      enter('preparing-workspace');
      // `source.branch` (if any) was already checked against the baseline's refs at the
      // create door, so the checkout inside `prepare` is a local operation expected to
      // succeed; a failure here is a real fault and lands as WORKSPACE_PREPARE_FAILED.
      const ws = await this.workspace.prepare(sandbox.id, source);
      done();
      this.recordWorkspacePrepared(sandbox, ws);

      this.advance(sandbox, 'creating', 'scheduler');
      enter('creating');
      const image = await this.imageSpecOf(sandbox);
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
          image: image.spec,
          // ⚠️ ORDER IS THE GUARANTEE, NOT A BLACKLIST (05 §4.1「凭证永远赢，靠顺序而非
          // 校验」). The image's own run parameters go in FIRST and the runtime
          // credential LAST, so a user-defined variable can never shadow a credential
          // — and `EnvVarSet` already refuses the credential NAMES at save time, which
          // makes this belt and braces rather than either alone.
          env: { ...image.env, ...(credential?.env ?? {}) },
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
          providerState: handle.providerState ?? null,
        });
        this.persist(sandbox); // save handle (no new transition/event)
        done();

        this.advance(sandbox, 'starting', 'scheduler');
        enter('starting');
        // ⚠️ **在这里问、而不是在 `runStartingSteps` 里面问**,有两个理由:
        // ① 阶段结束时再问永远得到 `true`（镜像那时已经铺好了）—— 那等于什么都没说,
        //    而这条信息的全部价值就是解释**这一段为什么慢**;
        // ② 失败路径同样拿得到它。`provider.start()` 炸在铺 13GB 镜像的中途,与炸在
        //    一个早就 staged 的镜像上,是两个不同的故障,下一步动作也不同。
        stageDetail = await this.imageStagedOf(provider, image.spec);
        await this.runStartingSteps(sandbox, provider, handle, image.spec, credential, stageDetail);
        done();
      } finally {
        credential?.zeroize();
      }

      this.advance(sandbox, 'running', 'scheduler');
      this.recordStage(sandbox, 'provision', provisionStartedAt, 'ok');
    } catch (e) {
      // ⚠️ **两条，不是一条。** 失败那一段（哪一步炸的）与整段 provision（用户等了
      // 多久才看见失败）回答的是两个不同的问题，而失败路径上聚合**不 publish 任何
      // 领域事件** —— projector 一条都收不到，这里不记就永远没有记录（13 §2.8.2）。
      this.recordStage(sandbox, stage, stageStartedAt, 'failed', e, stageDetail);
      // ⚠️ 整段 `provision` **刻意不带** stageDetail:它横跨多个阶段,把某一段的解释
      // 挂在总计上会让读者以为那是整段的成因。
      this.recordStage(sandbox, 'provision', provisionStartedAt, 'failed', e);
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
    const startedAt = this.clock.now().getTime();
    let stageDetail: Record<string, unknown> = {};
    try {
      this.advance(sandbox, 'starting', 'scheduler');
      const credential = await this.prepareCredential(sandbox);
      try {
        const spec = (await this.imageSpecOf(sandbox)).spec;
        // 重启同样要问 —— 停机期间镜像可能已被回收，那时这一次重启会和首次一样慢，
        // 而用户对「重启」的时间预期比「新建」短得多。
        stageDetail = await this.imageStagedOf(provider, spec);
        await this.runStartingSteps(sandbox, provider, handle, spec, credential, stageDetail);
      } finally {
        credential?.zeroize();
      }
      this.advance(sandbox, 'running', 'scheduler');
      this.recordStage(sandbox, 'restart', startedAt, 'ok', undefined, stageDetail);
    } catch (e) {
      this.recordStage(sandbox, 'restart', startedAt, 'failed', e, stageDetail);
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
    /** 调用方已经问过了 —— 这里再问一次会拿到不同的答案，见调用点的注释。 */
    imageStaged: { imageStaged?: boolean },
  ): Promise<void> {
    // ① + ② — start, and gate on in-sandbox agent readiness (inside `start`).
    //
    // ⚠️ 这一个 `await` 是整段 provision 里**最长、且唯一没有任何事件覆盖**的一段：
    // 实测冷 store 190529ms（13GB 的 `platform/sandbox:v2` 现拉 + 铺 rootfs），期间
    // `sandbox.status` 恒为 `starting`、CPU 是 0%、到 registry 一条连接都没有 ——
    // 用户判它卡死，排查的人第一眼也判它卡死。下面两帧就是为了把这一段的**边界**
    // 说出来；进度百分比没有（provider 只给得出「开始」和「结束」，编一个就是幽灵字段）。
    this.broadcaster.broadcast({
      event: 'sandbox.instance_progress',
      sandboxId: sandbox.id,
      phase: 'starting',
      ...imageStaged,
    });
    await provider.start(handle);
    this.broadcaster.broadcast({
      event: 'sandbox.instance_progress',
      sandboxId: sandbox.id,
      phase: 'ready',
    });
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

  /**
   * 「本机是不是已经有这份镜像了」—— provider 答得上就带上，答不上就**整个字段缺席**。
   *
   * ⚠️ 返回的是一个**待展开的片段**而不是 `boolean | undefined`，就是为了让「缺席」
   * 在类型层面成立：`{ imageStaged: undefined }` 会被 `JSON.stringify` 抹掉，看起来
   * 没差，但它让「没问过」和「问了说没有」在代码里长得一模一样。
   *
   * ⚠️ 三种「答不上」在这里合成同一种处置（不实现 / 抛异常 / provider 不可用），因为
   * 对用户是同一件事：这次说不出为什么慢。**它绝不能让 provision 失败** —— 一句文案的
   * 输入把整个 Task 判死，是拿装饰品当承重墙。
   */
  private async imageStagedOf(
    provider: SandboxProvider,
    image: ResolvedImageSpec,
  ): Promise<{ imageStaged?: boolean }> {
    if (!provider.imageStaged) return {};
    try {
      return { imageStaged: await provider.imageStaged(image) };
    } catch (e) {
      this.logger.warn(
        `provider '${provider.name}' could not report image staging for '${image.ref}' ` +
          `(${(e as Error).message}); the startup card falls back to generic copy`,
      );
      return {};
    }
  }

  private handleOf(sandbox: Sandbox): SandboxHandle {
    if (!sandbox.providerSandboxId) {
      throw new Error(`sandbox ${sandbox.id} has no provider handle to restart`);
    }
    return {
      provider: sandbox.provider,
      providerSandboxId: sandbox.providerSandboxId,
      providerState: sandbox.providerState ?? undefined,
    };
  }

  /**
   * The image the sandbox actually runs — 04 §7 时刻④, and the step without which
   * the other three are bookkeeping.
   *
   * ⚠️ THIS METHOD USED TO READ, IN FULL:
   *     `return { ref: sandbox.imageRef, digest: 'sha256:unresolved' };`
   * A hard-coded placeholder, while 04 §7's method table said 「必须解出 digest，
   * 否则同一 tag 前后两次创建可能不是同一镜像」. Three consequences, none theoretical:
   * `:latest` could drift with the platform completely unaware; two sandboxes 「on the
   * same image」 could be running different bits with no column able to say so; and
   * `imagePreinstalls()` matched a TAG rather than the bits behind it.
   *
   * Now it reads the FROZEN coordinate back from the manifest row that
   * `sandboxes.image_ref` points at. The row is immutable (I-IMG-7), so the digest a
   * historical Task ran is still exactly recoverable — which is what makes I-IMG-3's
   * 「历史引用仍合法」 a structural guarantee instead of a promise.
   *
   * ⚠️ A NULL `image_ref` IS A PRE-SLICE ROW, AND IT DEGRADES RATHER THAN CRASHING.
   * The migration NULLed those rows because inventing a digest for them would be the
   * placeholder again (13 §2.1). Restarting such a sandbox falls back to the platform
   * default image with an empty digest — `pinnedImageRef` then degrades to the tag,
   * i.e. exactly the pre-slice behaviour, LOUDLY logged. Failing outright would strand
   * every sandbox that existed before the upgrade.
   */
  private async imageSpecOf(
    sandbox: Sandbox,
  ): Promise<{ spec: ResolvedImageSpec; env: Record<string, string> }> {
    const selected =
      sandbox.imageRef === '' ? null : await this.images.findTaskImage(sandbox.imageRef);
    if (selected) {
      return {
        spec: {
          ref: selected.ref,
          digest: selected.digest,
          entrypoint: selected.entrypoint,
          // ⚠️ THE INSTALL PLAN'S ONLY HONEST INPUT (04 §7 ★ 第 3 条, now closed).
          // `getInstallPlan()` used to decide 「预装了没有」 by regex-matching this
          // sandbox's REF STRING — a guess about a name that is wrong for a mirror
          // (`localhost:5001/platform/sandbox:v1`) and blind to any user image. What
          // the image itself declared is stored on the manifest row; carrying it here
          // is what lets the plan answer 「0 秒」 vs 「约 12.5 分钟」 about the bits
          // that will actually be pulled.
          supportedRuntimes: selected.manifest.supportedRuntimes,
        },
        env: selected.env ?? {},
      };
    }
    this.logger.warn(
      `sandbox ${sandbox.id} has no image manifest ('${sandbox.imageRef}'): it predates the ` +
        'image slice, so its digest is not recoverable — falling back to the tag (04 §7 时刻④)',
    );
    return {
      spec: { ref: builtinImageRef(), digest: '' },
      env: {},
    };
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
        // ⚠️ 一条 WARN 日志不够。「agent 起来了但没登录」在用户眼里是「它什么都没干」，
        // 而**没有任何领域事件**会记下这件事（缺席不是状态流转）。这正是 13 §2.8.2
        // 说的「写入口 ② 覆盖失败路径」那一类。
        this.audit.record({
          category: 'sandbox',
          type: 'sandbox.credential.absent',
          severity: 'warn',
          subjectType: 'sandbox',
          subjectId: sandbox.id,
          actor: 'scheduler',
          summary: `没有可用的 ${sandbox.runtime} 凭证，agent 将以未登录状态启动`,
          detail: { runtimeId: sandbox.runtime },
          outcome: 'skipped',
          errorCode: e.code,
        });
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
    const startedAt = this.clock.now().getTime();
    const result = await this.agentSessions.bootstrapAgentSession({
      sandboxId: sandbox.id,
      runtimeId: sandbox.runtime,
      initialPrompt: pending ? sandbox.initialTask.prompt : undefined,
      workdir: SANDBOX_WORKSPACE_MOUNT,
      exec,
    });
    // 03 §7.8 `sandbox.agent_session`:「起没起 / 跑的是什么」——「要进 tmux 才知道
    // CLI 没起」是这条记录补的那个查不出来。⚠️ **不记 prompt 正文**：最长 8000 字符
    // 的用户内容，审计要的是身份不是正文（同 `AgentTaskStarted` 的纪律）。
    this.audit.record({
      category: 'sandbox',
      type: 'sandbox.agent_session',
      subjectType: 'sandbox',
      subjectId: sandbox.id,
      actor: 'scheduler',
      summary: result.reusedExisting
        ? `agent 会话已存在，沿用（${sandbox.runtime}）`
        : `已启动 ${sandbox.runtime} agent 会话`,
      detail: {
        runtimeId: sandbox.runtime,
        started: !result.reusedExisting,
        reusedExisting: result.reusedExisting,
        promptCarried: result.promptConsumed,
      },
      durationMs: Math.max(0, this.clock.now().getTime() - startedAt),
      outcome: 'ok',
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
      const failure = splitFailure(error);
      if (failure.rejected !== undefined) {
        this.logger.error(
          `sandbox ${sandbox.id}: '${failure.rejected}' is not in SANDBOX_FAILURE_CODES — ` +
            `recorded as ${INTERNAL_ERROR_CODE}. Register it, or wrap the throw site.`,
        );
      }
      sandbox.failWith(
        { code: failure.code, message: failure.message },
        'scheduler',
        this.clock.now(),
      );
      this.persist(sandbox);
    } catch {
      // best-effort marking; a terminal state legitimately refuses the move
    }
  }

  /**
   * 一条 `sandbox.provision.stage`（03 §7.8：每阶段结束，含 `duration_ms` 与 outcome）。
   *
   * ⚠️ `errorCode` 走 `splitFailure` 的**同一条**闭集判定，而不是把 `error.code` 直接
   * 抄进来 —— 否则 fs 的 `ENOSPC` 会以「平台错误码」的身份进审计流，与它当初进
   * `failure_code` 时闯的祸一模一样（见本文件底部 `splitFailure` 的长注释）。
   */
  private recordStage(
    sandbox: Sandbox,
    stage: string,
    startedAt: number,
    outcome: 'ok' | 'failed',
    error?: unknown,
    extra?: Record<string, unknown>,
  ): void {
    const failure = error === undefined ? undefined : splitFailure(error);
    this.audit.record({
      category: 'sandbox',
      type: 'sandbox.provision.stage',
      severity: outcome === 'failed' ? 'error' : 'info',
      subjectType: 'sandbox',
      subjectId: sandbox.id,
      actor: 'scheduler',
      summary:
        outcome === 'failed' ? `provision 阶段「${stage}」失败` : `provision 阶段「${stage}」完成`,
      detail: {
        stage,
        ...extra,
        ...(failure === undefined ? {} : { message: failure.message }),
      },
      durationMs: Math.max(0, this.clock.now().getTime() - startedAt),
      outcome,
      ...(failure === undefined ? {} : { errorCode: failure.code }),
    });
  }

  /**
   * 03 §7.8 `sandbox.workspace.prepared`:「源 baseline **是否存在** / 产出条目数」，
   * 补的是「**workspace 空了无人报错**」。
   *
   * ⚠️ baseline 读不到时 `prepare()` 是**静默**降级成空工作区的，所以这条在
   * `baselineExisted === false` 时是 `warn` —— 那是最需要有人看见的一种"成功"。
   *
   * ⚠️ `entryCount === 0`（**产出为空**）同样是 `warn`，而且它与上一条是**两件事**：
   * baseline 读到了、只是里面什么都没有（空项目，或者一次导入把东西丢在了别处）。
   * 这个分支曾经是**死代码** —— adapter 把自己写的 `.platform-workspace-state` 也数进
   * `entryCount` 里，于是真实文件系统上它恒 ≥ 1（实测），空工作区反而被报成
   * 「1 个顶层条目 / info」。计数口径已在 adapter 侧改掉（见 `PreparedWorkspace.
   * entryCount`），这里因此真的会被走到。
   */
  private recordWorkspacePrepared(
    sandbox: Sandbox,
    ws: { hostPath: string; baselineExisted: boolean; entryCount: number },
  ): void {
    const empty = ws.entryCount === 0;
    this.audit.record({
      category: 'sandbox',
      type: 'sandbox.workspace.prepared',
      severity: ws.baselineExisted && !empty ? 'info' : 'warn',
      subjectType: 'sandbox',
      subjectId: sandbox.id,
      actor: 'scheduler',
      summary: !ws.baselineExisted
        ? '工作区就绪，但源 baseline 读不到 —— 工作区是空的'
        : empty
          ? '工作区就绪，但里面一个文件都没有 —— 源 baseline 是空的'
          : `工作区就绪，${String(ws.entryCount)} 个顶层条目`,
      detail: {
        baselineExisted: ws.baselineExisted,
        entryCount: ws.entryCount,
        hostPath: ws.hostPath,
      },
      outcome: 'ok',
    });
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
 * The message is kept as DETAIL only — deliberately not concatenated with the code.
 * Prose gets reworded; a UI that had to parse the code back out of it would break.
 */
function splitFailure(error: unknown): { code: string; message: string; rejected?: string } {
  const message = error instanceof Error ? error.message : String(error);
  const raw =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;

  // ⚠️ THE `.code` IS CHECKED AGAINST THE CLOSED SET, NOT MERELY TESTED FOR BEING A
  // NON-EMPTY STRING. This function's own comment used to claim 「every error … already
  // carries a code from the 04 §4 closed set」 and then trusted any string it found.
  // Node's fs errors carry `.code` too, so `ENOSPC` / `ENOENT` / `EACCES` became the
  // sandbox's `failureCode`, went into the DB and out over WS — and the frontend, which
  // looks the code up in the P22 §1 copy table, found nothing and fell back to generic
  // text FOR THE FAILURE WITH THE CLEAREST USER ACTION ("free some disk").
  //
  // The right place to name a failure is where it is RAISED (`WorkspacePrepareError`
  // now does), because only there is it known what was being attempted. This is the
  // backstop for everything that does not.
  if (isSandboxFailureCode(raw)) return { code: raw, message };
  return {
    code: INTERNAL_ERROR_CODE,
    message,
    // Not silent: an UNREGISTERED platform code degrades user-facing copy invisibly.
    // Anything that reaches here with a code the set does not know is either a new
    // error class nobody registered in `SANDBOX_FAILURE_CODES` or a raw system error
    // that should have been wrapped — both are bugs, and both are shaped exactly like
    // "works fine" from the outside.
    rejected: typeof raw === 'string' && raw !== '' ? raw : undefined,
  };
}
