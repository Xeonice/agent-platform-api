import { z } from 'zod';

/** Authenticated, read-only observation. Separate from the v1 metadata protocol. */
export const RuntimeOwnerCapacitySchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.string().min(1).max(128),
    ownerId: z.string().min(1).max(128),
    startIdentity: z.string().min(16).max(512),
    artifactDigest: z.string().min(1).max(256),
    observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    capacity: z
      .object({
        cores: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
        ramMb: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        diskTotalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        diskAvailableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .refine((value) => value.diskAvailableBytes <= value.diskTotalBytes, {
        message: 'Available disk exceeds the observed total',
      }),
  })
  .strict();

export type RuntimeOwnerCapacity = z.infer<typeof RuntimeOwnerCapacitySchema>;
