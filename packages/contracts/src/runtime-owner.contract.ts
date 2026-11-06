import { z } from 'zod';

/** Private, authenticated owner protocol. Never exposed in a browser DTO. */
export const RuntimeOwnerFenceSchema = z
  .object({
    instanceId: z.string().min(1).max(128),
    holderId: z.literal('state-coordinator'),
    sessionId: z.string().min(16).max(128),
    generation: z.number().int().positive(),
    fence: z.number().int().positive(),
    leaseExpiresAt: z.number().int().positive(),
    operationId: z.string().min(1).max(256),
    sandboxId: z.string().max(256).optional(),
    actor: z
      .object({ kind: z.enum(['user', 'automation', 'system']), id: z.string().min(1).max(256) })
      .strict(),
    authority: z.enum(['business', 'observe']),
  })
  .strict();
export type RuntimeOwnerFence = z.infer<typeof RuntimeOwnerFenceSchema>;

export const RuntimeOwnerMethods = [
  'create',
  'start',
  'stop',
  'destroy',
  'inspect',
  'spawn',
  'updateResources',
  'imageStaged',
  'stageImage',
  'destroyBySandboxId',
  'watchEvents',
  'jobs.startJob',
  'jobs.readJob',
  'jobs.killJob',
  'jobs.releaseJob',
  'files.readFile',
  'files.writeFile',
  'files.listFiles',
  'files.openFileStream',
  'stream.write',
  'stream.resize',
  'stream.kill',
  'stream.detach',
] as const;
export type RuntimeOwnerMethod = (typeof RuntimeOwnerMethods)[number];
export const RuntimeOwnerCallSchema = z
  .object({
    provider: z.string().min(1).max(128),
    method: z.enum(RuntimeOwnerMethods),
    args: z.array(z.unknown()).max(8),
    fence: RuntimeOwnerFenceSchema,
  })
  .strict();
export type RuntimeOwnerCall = z.infer<typeof RuntimeOwnerCallSchema>;

export const RuntimeOwnerHandleSchema = z
  .object({
    provider: z.string().min(1),
    providerSandboxId: z.string().min(1),
    providerState: z.record(z.unknown()).optional(),
  })
  .strict();
export const RuntimeOwnerImageSchema = z
  .object({
    ref: z.string().min(1),
    digest: z.string().min(1),
    entrypoint: z.array(z.string()).optional(),
    supportedRuntimes: z.array(z.string()).optional(),
  })
  .strict();
export const RuntimeOwnerContextSchema = z
  .object({
    sandboxId: z.string().min(1),
    quota: z
      .object({
        cores: z.number().positive(),
        ramMb: z.number().positive(),
        diskMb: z.number().nonnegative(),
      })
      .strict(),
    image: RuntimeOwnerImageSchema,
    env: z.record(z.string()),
    labels: z.record(z.string()).optional(),
    volumes: z
      .array(
        z
          .object({
            source: z.string(),
            target: z.string(),
            mode: z.enum(['ro', 'rw']),
            kind: z.enum(['host-path', 'persistent', 'ephemeral']),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const RuntimeOwnerLeaseClaimSchema = z
  .object({
    instanceId: z.string().min(1).max(128),
    holderId: z.literal('state-coordinator'),
    sessionId: z.string().min(16).max(128),
    generation: z.number().int().positive(),
    expectedFence: z.number().int().nonnegative(),
    ttlMs: z.number().int().min(1000).max(30000),
  })
  .strict();
export type RuntimeOwnerLeaseClaim = z.infer<typeof RuntimeOwnerLeaseClaimSchema>;
export const RuntimeOwnerLeaseSchema = z
  .object({
    instanceId: z.string(),
    holderId: z.literal('state-coordinator'),
    sessionId: z.string(),
    generation: z.number().int().positive(),
    fence: z.number().int().nonnegative(),
    leaseExpiresAt: z.number().int().nonnegative(),
  })
  .strict();
export type RuntimeOwnerLease = z.infer<typeof RuntimeOwnerLeaseSchema>;
export const RuntimeOwnerLeaseReleaseSchema = RuntimeOwnerLeaseClaimSchema.omit({
  ttlMs: true,
  expectedFence: true,
})
  .extend({ fence: z.number().int().positive() })
  .strict();

export const RuntimeOwnerCapabilitiesSchema = z
  .object({
    spawnTty: z.boolean(),
    volumeMount: z.boolean(),
    updateResources: z.boolean(),
    pauseResume: z.boolean(),
    snapshot: z.boolean(),
    watchEvents: z.boolean(),
    headlessTask: z.boolean(),
  })
  .strict();
export const RuntimeOwnerMetadataSchema = z
  .object({
    protocol: z.literal(1),
    instanceId: z.string(),
    ownerId: z.string(),
    pid: z.number().int().positive().optional(),
    startIdentity: z.string().nullable().optional(),
    artifactDigest: z.string().nullable().optional(),
    inputFingerprint: z.string().nullable().optional(),
    role: z.literal('runtime-owner').optional(),
    databaseScope: z.literal('owner-private').optional(),
    noBusinessDatabaseAccess: z.literal(true).optional(),
    lease: RuntimeOwnerLeaseSchema.nullable(),
    providers: z.array(
      z
        .object({
          name: z.string(),
          capabilities: RuntimeOwnerCapabilitiesSchema,
          methods: z.array(z.enum(RuntimeOwnerMethods)),
        })
        .strict(),
    ),
    defaultProvider: z.string(),
  })
  .strict();
export type RuntimeOwnerMetadata = z.infer<typeof RuntimeOwnerMetadataSchema>;

export const RuntimeOwnerStreamFrameSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('data'), seq: z.number().int().positive(), data: z.string() })
    .strict(),
  z
    .object({
      type: z.literal('exit'),
      seq: z.number().int().positive(),
      code: z.number().int().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('progress'),
      seq: z.number().int().positive(),
      bytes: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({ type: z.literal('error'), seq: z.number().int().positive(), code: z.string() })
    .strict(),
  z
    .object({
      type: z.literal('provider-event'),
      seq: z.number().int().positive(),
      event: z
        .object({
          providerSandboxId: z.string(),
          lifecycleState: z.enum([
            'instance_creating',
            'instance_running',
            'instance_paused',
            'instance_exited',
            'instance_dead',
            'instance_missing',
          ]),
          at: z.string(),
        })
        .strict(),
    })
    .strict(),
]);
export type RuntimeOwnerStreamFrame = z.infer<typeof RuntimeOwnerStreamFrameSchema>;
