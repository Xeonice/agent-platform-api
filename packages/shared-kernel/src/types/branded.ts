/**
 * Branded (nominal) types — compile-time distinct, runtime plain string.
 * See docs/backend/28 §2.1: prevents e.g. passing a ProjectId where a SandboxId is required.
 */
export type Brand<K, T> = K & { readonly __brand: T };

export type SandboxId = Brand<string, 'SandboxId'>;
/** A headless agent run inside a sandbox (S6). Distinct from `SandboxId`: 一个 sandbox 可以跑多轮 Task。 */
export type AgentTaskId = Brand<string, 'AgentTaskId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type CredentialId = Brand<string, 'CredentialId'>;
/** 已保留的工作区卷（23 §6.2 独立聚合 D-4）。**不是** `SandboxId`：卷的生命周期长于 sandbox 记录。 */
export type RetainedVolumeId = Brand<string, 'RetainedVolumeId'>;
export type ImageId = Brand<string, 'ImageId'>;
export type AutomationId = Brand<string, 'AutomationId'>;
export type NodeId = Brand<string, 'NodeId'>;

// NOTE: the transaction token `Tx` lives in ./ports/unit-of-work.port — it is
// opaque and mintable ONLY inside UnitOfWork.run (P2-1), not a branded id here.

function nominalId<T extends string>(value: string): Brand<string, T> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Nominal tags have no runtime representation; this central types boundary only labels an already typed string, never validates external data.
  return value as Brand<string, T>;
}

export const asSandboxId = (v: string): SandboxId => nominalId<'SandboxId'>(v);
export const asAgentTaskId = (v: string): AgentTaskId => nominalId<'AgentTaskId'>(v);
export const asProjectId = (v: string): ProjectId => nominalId<'ProjectId'>(v);
export const asCredentialId = (v: string): CredentialId => nominalId<'CredentialId'>(v);
export const asRetainedVolumeId = (v: string): RetainedVolumeId => nominalId<'RetainedVolumeId'>(v);
export const asImageId = (v: string): ImageId => nominalId<'ImageId'>(v);
export const asAutomationId = (v: string): AutomationId => nominalId<'AutomationId'>(v);
export const asNodeId = (v: string): NodeId => nominalId<'NodeId'>(v);
