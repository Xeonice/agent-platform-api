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
export type ImageId = Brand<string, 'ImageId'>;
export type AutomationId = Brand<string, 'AutomationId'>;
export type NodeId = Brand<string, 'NodeId'>;

// NOTE: the transaction token `Tx` lives in ./ports/unit-of-work.port — it is
// opaque and mintable ONLY inside UnitOfWork.run (P2-1), not a branded id here.

export const asSandboxId = (v: string): SandboxId => v as SandboxId;
export const asAgentTaskId = (v: string): AgentTaskId => v as AgentTaskId;
export const asProjectId = (v: string): ProjectId => v as ProjectId;
export const asCredentialId = (v: string): CredentialId => v as CredentialId;
export const asImageId = (v: string): ImageId => v as ImageId;
export const asAutomationId = (v: string): AutomationId => v as AutomationId;
