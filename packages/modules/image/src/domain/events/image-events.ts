import type { DomainEvent } from '@platform/shared-kernel';

/**
 * Image-context domain events (docs/backend/23 §9.6). Written to the outbox in-tx.
 *
 * ── 为什么是**类**而不是接口 ────────────────────────────────────────────────
 * 平台级 `AuditProjector` 靠 `instanceof` 判别（audit.projector.ts）。接口在运行期
 * 什么都不是，只能退回按 `e.type` 字符串比对 —— 而字符串比对在字段被改名、事件被拆分
 * 时**一条编译错误都不会有**，正是审计这一侧最不该有的一类沉默。本仓其余四个上下文
 * （sandbox / project / credential / runtime）的事件都已经是类。
 *
 * ── 为什么每一条都带 `ref` ──────────────────────────────────────────────────
 * 13 §2.8.2 把 `summary` 写成了可验收的一条：**这一列不许出现 UUID**。镜像的
 * `manifestId` 是 UUID，而用户认得的串是 `registry/repo:tag`（就是他自己粘进注册框的
 * 那一行）。没有这个字段，projector 只能写出 `停用镜像 8f3c1d02-…` —— 而
 * 「谁把生产镜像停用了」正是这一档审计存在的理由。
 *
 * ⚠️ **`ref` 随事件走，projector 不回查当前库**：审计是历史快照。同一个 tag 的现任
 * 版本随时会被 `activate` 换掉、整行也可能被删，那条审计行都该保持原样
 * （13 §2.8.2 summary 行的最后一句）。
 *
 * ⚠️ 它是**完整坐标**（`platform/sandbox:v2`），不是 `version` 单独一段。此前
 * `ImageRegistered.ref` 塞的是 `props.version`，也就是一个孤零零的 `v2` —— 那个串
 * 在面板上和 UUID 一样认不出是哪张镜像。
 */

/** 一张 manifest 行诞生（04 §7 时刻①，tag → digest 的那一刻）。 */
export class ImageRegistered implements DomainEvent {
  readonly type = 'image.registered';
  constructor(
    readonly manifestId: string,
    readonly imageId: string,
    /** 完整坐标 `registry/repo:tag`（digest 注册时为 `repo@sha256:…`）。 */
    readonly ref: string,
    readonly digest: string,
    readonly occurredAt: Date,
  ) {}
}

export class ImageValidated implements DomainEvent {
  readonly type = 'image.validated';
  constructor(
    readonly manifestId: string,
    readonly ref: string,
    /** Carried on the event because 三级 is the whole product semantics (P21-4 §5). */
    readonly status: string,
    readonly occurredAt: Date,
  ) {}
}

export class ImageActivated implements DomainEvent {
  readonly type = 'image.activated';
  constructor(
    readonly manifestId: string,
    readonly ref: string,
    readonly occurredAt: Date,
  ) {}
}

export class ImageDeactivated implements DomainEvent {
  readonly type = 'image.deactivated';
  constructor(
    readonly manifestId: string,
    readonly ref: string,
    readonly occurredAt: Date,
  ) {}
}

export class ImageConfigUpdated implements DomainEvent {
  readonly type = 'image.config_updated';
  constructor(
    readonly manifestId: string,
    readonly ref: string,
    readonly occurredAt: Date,
  ) {}
}

/**
 * `DELETE /api/images/:id` —— 整行硬删（不是停用）。
 *
 * ⚠️ **删除与停用必须分得开。** 停用（`ImageDeactivated`）只是把它移出选项列表，
 * 历史引用照旧合法（I-IMG-3）；删除是那行 bits 的坐标从平台上消失。事后只看到
 * 「这张镜像不见了」而分不清是哪一种，排查方向完全相反。
 *
 * ⚠️ 与 `ProjectDeleted` 同理：行即将消失，事件是唯一的去处，`ref` 也没有任何库
 * 可以回查（13 §2.8.2「审计必须在主体被删除之后继续存在」）。
 */
export class ImageDeleted implements DomainEvent {
  readonly type = 'image.deleted';
  constructor(
    readonly manifestId: string,
    readonly ref: string,
    readonly occurredAt: Date,
  ) {}
}
