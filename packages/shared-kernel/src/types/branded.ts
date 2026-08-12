/**
 * Branded (nominal) types — compile-time distinct, runtime plain string.
 * See docs/backend/28 §2.1: prevents e.g. passing a ProjectId where a SandboxId is required.
 */
export type Brand<K, T> = K & { readonly __brand: T };

export type SandboxId = Brand<string, 'SandboxId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type CredentialId = Brand<string, 'CredentialId'>;
export type ImageId = Brand<string, 'ImageId'>;
export type AutomationId = Brand<string, 'AutomationId'>;
export type NodeId = Brand<string, 'NodeId'>;

/** Opaque transaction handle — only ever passed through saveSync(tx). (28 §7.3) */
export type Tx = Brand<object, 'Tx'>;

export const asSandboxId = (v: string): SandboxId => v as SandboxId;
export const asProjectId = (v: string): ProjectId => v as ProjectId;
export const asCredentialId = (v: string): CredentialId => v as CredentialId;
export const asImageId = (v: string): ImageId => v as ImageId;
export const asAutomationId = (v: string): AutomationId => v as AutomationId;
