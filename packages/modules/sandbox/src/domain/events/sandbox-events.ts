import type { DomainEvent, SandboxId, ProjectId } from '@platform/shared-kernel';
import type { SandboxStatus } from '../value-objects/sandbox-status.vo';
import type { TriggeredBy } from '../entities/state-transition.entity';

/**
 * Domain events use DOMAIN names, not WS projection names (23 §12): the domain
 * event is the source, the WS frame is a projection (not 1:1).
 * e.g. SandboxStateChanged → WS `sandbox.status_changed`.
 */
export class SandboxCreated implements DomainEvent {
  readonly type = 'SandboxCreated';
  constructor(
    readonly sandboxId: SandboxId,
    readonly projectId: ProjectId,
    /**
     * 沙箱（= 任务）的**显示名随事件一起走**，不是让消费者回头查库。
     *
     * 理由一（当下）：审计流的 `summary` 要求是「一行人话，直接上 UI」（13 §2.8.2）。
     * 没有这个字段，projector 只能写出 `创建沙箱 8f3c1d02-…`——sandbox 类事件是审计流里
     * **数量最多的一类**（一次 provision 就是六个阶段 + 五次状态流转），整屏 UUID 等于
     * 让人第一次点开审计面板就再也不点第二次。
     *
     * 理由二（更要紧）：审计是**历史快照**，记的必须是**当时**的名字。任务后来被改名
     * （`deriveDefaultTaskName` 只在创建时算一次，此后平台永不覆盖用户的重命名）、
     * 甚至沙箱被销毁，那条审计行都该保持原样。回查当前库拿名字会让历史随现状漂移，
     * 而这正是审计要防的事。
     *
     * ⚠️ 用的是 `name` 而不是 `runtime`/`provider` 这类组合：`name` 正是任务列表上
     * 那一列（P21-1 §9），审计行与列表因此说的是同一个词；而它在没有指令时会退化成
     * `Codex · 2026-08-10 14:23`（runtime + 时刻），本身已经带上了辨识度。
     * ⚠️ 它派生自 `initialPrompt` 的首行前 20 个码点——**指令原文仍然不出后端**
     * （裁决 D-14），进来的只有那条早已在任务列表上公开显示的名字。
     */
    readonly name: string,
    readonly occurredAt: Date,
  ) {}
}

export class SandboxStateChanged implements DomainEvent {
  readonly type = 'SandboxStateChanged';
  constructor(
    readonly sandboxId: SandboxId,
    readonly from: SandboxStatus,
    readonly to: SandboxStatus,
    /**
     * **谁推动了这一步**（03 §7.8「已有 transitions，补 actor」）。
     *
     * ⚠️ 它此前只落在 `sandbox_state_transitions` 行里，事件上没有 —— 于是订阅方
     * （WS 投影、审计 projector）要么不知道，要么得回查一次数据库。而「这个沙箱是
     * 自己 idle 被 reaper 收走的，还是用户按了停止」正是排障第一个要问的
     * （13 §2.8.2 对 `actor` 的原话）。同一次流转，两处记录不该只有一处有答案。
     */
    readonly triggeredBy: TriggeredBy,
    readonly occurredAt: Date,
    /**
     * Set only when `to === 'failed'`: the machine-readable cause, carried on the
     * event so the WS projection can hand the frontend a CODE rather than leaving it
     * to guess. Provisioning is async, so this event is the only LIVE channel a
     * failure has (04 §4) — the same code is persisted for the post-refresh read.
     */
    readonly errorCode?: string,
  ) {}
}
