import { AggregateRoot } from '@platform/shared-kernel';
import type { SandboxId, ProjectId } from '@platform/shared-kernel';
import { SandboxStatusVO } from '../value-objects/sandbox-status.vo';
import type { SandboxStatus } from '../value-objects/sandbox-status.vo';
import type { StateTransition, TriggeredBy } from './state-transition.entity';
import { InvalidSandboxTransitionError } from '../errors/invalid-transition.error';
import { SandboxCreated, SandboxStateChanged } from '../events/sandbox-events';
import { InitialTask } from '../value-objects/initial-task.vo';
import { deriveDefaultTaskName } from '../services/task-name.policy';

export interface SandboxProps {
  id: SandboxId;
  projectId: ProjectId;
  runtime: string;
  /** Runtimes whose credential provision actually injected (03 §4.3 ④). */
  injectedRuntimes: string[];
  provider: string;
  /** Task display name; defaulted from `initialTask.prompt` at create time. */
  name: string;
  /** The image this sandbox actually runs (13 §2.1.1 `image_ref`). */
  imageRef: string;
  status: SandboxStatus;
  headless: boolean;
  /** null for interactive tasks; 30/60/120/240 for headless (13 §2.1). */
  timeoutMinutes: number | null;
  idleTimeoutSec: number;
  workspacePath: string | null;
  /** provider's opaque sandbox id (SandboxHandle.providerSandboxId); null until created. */
  providerSandboxId: string | null;
  /**
   * Provider 的私有运行期状态，原样持久化、原样交还（`SandboxHandle.providerState`）。
   *
   * ⚠️ **领域层不解释它的内容，一个键都不认。** 这里曾经是 `agentEndpointPort` +
   * `agentAuthToken` 两个具名字段——一种 provider 的一种数据面实现（AIO 镜像里的
   * HTTP agent）的词汇，一路爬到了聚合根上。`Sandbox` 不该知道"端口"和"bearer token"
   * 这种东西存不存在；它只需要知道**有一坨状态要跟着这个沙箱走**，好让后端重启后
   * provider 能接回自己的实例。
   */
  providerState: Record<string, unknown> | null;
  /** "WHAT to run" — the create-time instruction + its one-shot consumed marker. */
  initialTask: InitialTask;
  /**
   * Machine-readable failure cause (13 §2.1.1 `failure_code`) — one of the 04 §4
   * codes. It is stored SEPARATELY from the free text on purpose: the frontend needs
   * something it can BRANCH on, and P22 §1 owns the sentence keyed by the code.
   * Embedding the code in a prose string would force the UI to parse prose.
   */
  failureCode: string | null;
  /** Free-text detail paired with `failureCode` — debugging aid, never UI copy. */
  failureReason: string | null;
  version: number;
  transitions: StateTransition[];
}

/**
 * Sandbox aggregate root (docs/backend/23 §5, 28 §2.2).
 * Holds the current status (a value object with the transition table) and an
 * append-only transition history persisted in the same aggregate.
 */
export class Sandbox extends AggregateRoot<SandboxId> {
  private _status: SandboxStatus;
  private _timeoutMinutes: number | null;
  private _idleTimeoutSec: number;
  private _workspacePath: string | null;
  private _providerSandboxId: string | null;
  private _providerState: Record<string, unknown> | null;
  private _initialTask: InitialTask;
  private _injectedRuntimes: string[];
  private _failureCode: string | null;
  private _failureReason: string | null;
  private _name: string;
  private _version: number;
  private readonly _transitions: StateTransition[];
  /** transitions appended in the current UoW, flushed by saveSync (28 §2.2). */
  private readonly _pendingTransitions: StateTransition[] = [];

  readonly projectId: ProjectId;
  /**
   * 这个沙箱是为哪个 runtime 建的 —— **默认值**，不是"唯一装了的那个"
   * （语义迁移见 `SandboxDtoSchema.runtime`）。
   */
  readonly runtime: string;
  readonly provider: string;
  readonly imageRef: string;
  readonly headless: boolean;

  private constructor(props: SandboxProps) {
    super(props.id);
    this.projectId = props.projectId;
    this.runtime = props.runtime;
    this._injectedRuntimes = props.injectedRuntimes;
    this.provider = props.provider;
    this.imageRef = props.imageRef;
    this.headless = props.headless;
    this._name = props.name;
    this._initialTask = props.initialTask;
    this._failureCode = props.failureCode;
    this._failureReason = props.failureReason;
    this._status = props.status;
    this._timeoutMinutes = props.timeoutMinutes;
    this._idleTimeoutSec = props.idleTimeoutSec;
    this._workspacePath = props.workspacePath;
    this._providerSandboxId = props.providerSandboxId;
    this._providerState = props.providerState;
    this._version = props.version;
    this._transitions = props.transitions;
  }

  /**
   * 实际注入了凭证的 runtime（03 §4.3 ④）。**读的是记录，不是推导**——理由见
   * `SandboxDtoSchema.injectedRuntimes`。
   *
   * ⚠️ 空数组有两种来源，对调用方是同一件事「没有任何一个 runtime 能在这里跑」：
   * ① provision 时一个凭证都没配；② 本切片之前建的旧行（该列 NULL，仓储层回落成
   * `[runtime]`，所以旧行读出来**不会**是空）。
   */
  get injectedRuntimes(): readonly string[] {
    return this._injectedRuntimes;
  }

  /**
   * 这个沙箱里**能跑哪几个 runtime** —— 默认那个 ∪ 实际注入了凭证的那些。
   *
   * ⚠️ **为什么要并上 `runtime` 而不是只看 `injectedRuntimes`**：一个凭证都没配的用户
   * 照样能建任务，agent 会以**未登录**状态起来（provision 为此专门记了一条
   * `sandbox.credential.absent`，文案就是「agent 将以未登录状态启动」）。只看注入列表
   * 会把这条一直存在的路直接掐掉 —— 「没配凭证」从「能跑，只是没登录」变成「什么都
   * 开不了」，而那不是本切片要改的东西。
   *
   * ⇒ 默认 runtime 的 CLI 由 provision 的 ③ 保证装好了（`ensureInstalled`），
   * 所以它**永远**可用；`injectedRuntimes` 只**扩大**这个集合，永不缩小它。
   *
   * ⚠️ 派生放在聚合上、只有这一处：`assertRunnable`（发任务）与终端（开 CLI 标签）
   * 必须给出同一个答案，两边各写一遍并集迟早会分叉。
   */
  get availableRuntimes(): readonly string[] {
    return [...new Set([this.runtime, ...this._injectedRuntimes])];
  }

  /**
   * provision 注入完成后落账（03 §4.3 ④）。**只在 provision/restart 里调**。
   *
   * ⚠️ restart 会重跑整个 `starting` 段、重新注入一次 ⇒ 这里是**覆盖**而不是并集：
   * 用户在两次启动之间删掉的凭证，重启之后盒子里确实就没有了，并集会让这条记录
   * 继续声称它还在。
   */
  recordInjectedRuntimes(runtimeIds: string[]): void {
    this._injectedRuntimes = [...runtimeIds];
  }

  /** Rehydrate from persistence (repository.toDomain). No events raised. */
  static rehydrate(props: SandboxProps): Sandbox {
    return new Sandbox(props);
  }

  /**
   * Create a brand-new sandbox in `pending` with its first transition.
   *
   * The `initialPrompt` is validated + stored HERE, inside T1 (26 §1): the consumer
   * (`bootstrapAgentSession`) runs in the provision workflow AFTER the 202, and that
   * workflow only ever receives a `sandboxId` — anything crossing that boundary must
   * be persisted (TASK-LAUNCH-DECISIONS T-1). The default display name is derived in
   * the same breath, which is what allows the prompt itself to stay off every DTO.
   */
  static create(input: {
    id: SandboxId;
    projectId: ProjectId;
    runtime: string;
    /** Human-facing runtime label used only for the fallback name. */
    runtimeLabel?: string;
    provider: string;
    imageRef: string;
    headless: boolean;
    initialPrompt?: string;
    timeoutMinutes: number | null;
    idleTimeoutSec: number;
    now: Date;
  }): Sandbox {
    const firstTransition: StateTransition = {
      from: null,
      to: 'pending',
      at: input.now,
      triggeredBy: 'user',
    };
    const initialTask = InitialTask.create({ prompt: input.initialPrompt });
    // 提出来是因为它有**两个**去处：聚合的字段，以及 `SandboxCreated` 事件——
    // 审计要记的是「当时」的名字，所以名字随事件走，而不是让 projector 回查库。
    const name = deriveDefaultTaskName({
      prompt: initialTask.prompt,
      runtimeLabel: input.runtimeLabel ?? input.runtime,
      now: input.now,
    });
    const sandbox = new Sandbox({
      id: input.id,
      projectId: input.projectId,
      runtime: input.runtime,
      // 建的时候还没注入任何东西 —— provision 跑完 ④ 才落账。
      injectedRuntimes: [],
      provider: input.provider,
      imageRef: input.imageRef,
      name,
      status: 'pending',
      headless: input.headless,
      timeoutMinutes: input.timeoutMinutes,
      idleTimeoutSec: input.idleTimeoutSec,
      workspacePath: null,
      providerSandboxId: null,
      providerState: null,
      initialTask,
      failureCode: null,
      failureReason: null,
      version: 0,
      transitions: [firstTransition],
    });
    sandbox._pendingTransitions.push(firstTransition);
    sandbox.raise(new SandboxCreated(input.id, input.projectId, name, input.now));
    return sandbox;
  }

  get status(): SandboxStatus {
    return this._status;
  }
  get name(): string {
    return this._name;
  }
  /** "WHAT to run" (23 §5.3). The prompt NEVER leaves the backend on a DTO (D-14). */
  get initialTask(): InitialTask {
    return this._initialTask;
  }
  get failureCode(): string | null {
    return this._failureCode;
  }
  get failureReason(): string | null {
    return this._failureReason;
  }
  get timeoutMinutes(): number | null {
    return this._timeoutMinutes;
  }
  get idleTimeoutSec(): number {
    return this._idleTimeoutSec;
  }
  get workspacePath(): string | null {
    return this._workspacePath;
  }
  get providerSandboxId(): string | null {
    return this._providerSandboxId;
  }
  /**
   * ⚠️ **可能含密**（如 aio 的 agent bearer token），只在 sandbox 上下文内可达，
   * **永远不映射到任何 wire DTO**。这条纪律原本挂在 `agentAuthToken` 的 getter 上；
   * 字段收成一坨之后它跟着收到这里——收拢字段不该把纪律弄丢。
   */
  get providerState(): Record<string, unknown> | null {
    return this._providerState;
  }
  get version(): number {
    return this._version;
  }

  /** Record the provider handle + host workspace once created (03 §4). */
  bindRuntime(input: {
    providerSandboxId: string;
    workspacePath: string;
    providerState?: Record<string, unknown> | null;
  }): void {
    this._providerSandboxId = input.providerSandboxId;
    this._workspacePath = input.workspacePath;
    this._providerState = input.providerState ?? null;
  }
  /**
   * Stamp the initial instruction as started (I-SBX-10). Called by the provision
   * workflow ONLY after `bootstrapAgentSession` actually started the session — a
   * session that failed to start has not consumed anything, otherwise a retry would
   * silently drop the user's instruction.
   */
  consumeInitialTask(at: Date): void {
    this._initialTask = this._initialTask.consume(at);
  }

  /**
   * Move to `failed` recording BOTH halves of the cause (13 §2.1.1):
   *   - `code` — machine-readable, from the 04 §4 closed set. This is what the wire
   *     carries (DTO + WS) and what the frontend branches on;
   *   - `message` — free-text detail for debugging. It is NOT the user-facing
   *     sentence: P22 §1 owns that, keyed by the code.
   *
   * They are two fields rather than one prose string because provisioning is async —
   * the only way a failure reaches the user is this record and its projection, and a
   * UI that had to regex a code out of prose would break on the first reworded message.
   */
  failWith(failure: { code: string; message: string }, triggeredBy: TriggeredBy, now: Date): void {
    this._failureCode = failure.code;
    this._failureReason = failure.message;
    this.transitionTo('failed', triggeredBy, now);
  }

  get transitions(): readonly StateTransition[] {
    return this._transitions;
  }
  get pendingTransitions(): readonly StateTransition[] {
    return this._pendingTransitions;
  }

  /**
   * Assert the move is legal (I-SBX-1), append history, raise the state-changed
   * event. Illegal moves throw InvalidSandboxTransitionError (→ 409).
   */
  transitionTo(next: SandboxStatus, triggeredBy: TriggeredBy, now: Date): void {
    if (!SandboxStatusVO.canTransitionTo(this._status, next)) {
      throw new InvalidSandboxTransitionError(this._status, next);
    }
    const from = this._status;
    const transition: StateTransition = { from, to: next, at: now, triggeredBy };
    this._transitions.push(transition);
    this._pendingTransitions.push(transition);
    this._status = next;
    this.raise(
      new SandboxStateChanged(
        this.id,
        from,
        next,
        triggeredBy,
        now,
        next === 'failed' ? (this._failureCode ?? undefined) : undefined,
      ),
    );
  }

  /** called by repository after a successful flush (28 §2.2). */
  markPersisted(newVersion: number): void {
    this._version = newVersion;
    this._pendingTransitions.length = 0;
  }
}
