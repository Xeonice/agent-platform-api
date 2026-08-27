import type { CredentialId, DomainEvent } from '@platform/shared-kernel';
import type { ObtainedVia } from '../value-objects/obtained-via.vo';

/**
 * 凭证的**身份**（不是内容）随事件一起走 —— `CredentialStored` / `CredentialRevoked`
 * 共用这两个字段。
 *
 * 理由一（当下）：审计流的 `summary` 要求是「一行人话，直接上 UI」（13 §2.8.2）。
 * 只有 id 的话那一行是 `保存凭证 3f9a77c1-…`，用户认不出自己刚存的是哪一个；而凭证
 * **没有用户起的名字**，能认人的只有「哪个 runtime + 什么获取方式」这个组合。
 *
 * 理由二（更要紧）：审计是**历史快照**。凭证被吊销时 `revoke()` 会把密文擦成
 * `Erased`（I-CRD-3），一条 `credentials` 行还可能被后来的清理带走 —— 回查当前库拿
 * 标识会让历史随现状漂移，正是审计要防的事。让身份随事件走，那一行就永远读得懂。
 *
 * ⛔ **这两个字段是身份，绝不是内容。** 密文、token 片段、`MaskedIdentifier`
 * （SSH 指纹 / token 末四位）**一个都不许上事件**：审计的 `summary` 与 `detail` 同受
 * 05 §4 脱敏纪律约束，而末四位是能反推凭证内容的东西。`runtimeId` 是平台自己的
 * runtime 标识（`claude-code`），`obtainedVia` 是获取方式（`oauth-device`）——
 * 两者都与秘密材料无关。
 */
interface CredentialIdentity {
  /** runtime 凭证的 runtime id（`claude-code` / `codex`）；git 凭证为 `null`（I-CRD-1）。 */
  readonly runtimeId: string | null;
  /** 获取方式：runtime 半区四值 ∪ git 半区 `git-ssh-key` / `git-https-token`。 */
  readonly obtainedVia: ObtainedVia;
}

/** Git credential domain events (docs/backend/23 §8.6). This slice raises Stored/Revoked. */
export class CredentialStored implements DomainEvent, CredentialIdentity {
  readonly type = 'CredentialStored';
  constructor(
    readonly credentialId: CredentialId,
    readonly runtimeId: string | null,
    readonly obtainedVia: ObtainedVia,
    readonly occurredAt: Date,
  ) {}
}

export class CredentialRevoked implements DomainEvent, CredentialIdentity {
  readonly type = 'CredentialRevoked';
  constructor(
    readonly credentialId: CredentialId,
    readonly runtimeId: string | null,
    readonly obtainedVia: ObtainedVia,
    readonly occurredAt: Date,
  ) {}
}

/** Runtime credential injected into a sandbox (23 §8.6, ledger source). */
export class CredentialInjected implements DomainEvent {
  readonly type = 'CredentialInjected';
  constructor(
    readonly credentialId: CredentialId,
    readonly sandboxId: string,
    readonly occurredAt: Date,
  ) {}
}
