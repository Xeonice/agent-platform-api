import { z } from 'zod';

export const RuntimeOwnerPlacementSchema = z
  .object({ ownerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) })
  .strict();

/** Internal scheduling boundary. No SDK, Docker or business authority is exposed. */
export interface RuntimeOwnerSchedulingSnapshot {
  ownerId: string;
  observedAt: number;
  capacity: { cores: number; ramMb: number; diskTotalBytes: number; diskAvailableBytes: number };
  ownerIds: readonly string[];
  helperOwnerId: string;
  assignments: readonly { ownerId: string; sandboxId: string; state: 'owned' | 'unconfirmed' }[];
}
export interface RuntimeOwnerScheduling {
  /** One fresh observation; a concurrent default-Owner switch rejects this observation. */
  snapshot(): Promise<RuntimeOwnerSchedulingSnapshot>;
  /** Immutable in-process CAS, reconstructed from the durable allocation before each create/lookup. */
  pin(sandboxId: string, ownerId: string): void;
  originalOwnerId(sandboxId: string): string | undefined;
  assertCurrent(observation: RuntimeOwnerSchedulingSnapshot): void;
}
export const RUNTIME_OWNER_SCHEDULING = Symbol('RuntimeOwnerScheduling');
