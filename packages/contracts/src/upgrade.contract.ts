import { z } from 'zod';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Revision = z.string().regex(/^[a-f0-9]{40}$/);
const Name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/);
const Release = z.string().regex(/^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/);
const Time = z.string().datetime();
export const UpgradeProtocolRangeSchema = z
  .object({ min: z.number().int().positive(), max: z.number().int().positive() })
  .passthrough()
  .refine((p) => p.min <= p.max);
export const UpgradeArtifactSchema = z
  .object({
    artifactDigest: Digest,
    inputFingerprint: Digest,
    sourceRevision: Revision,
    protocol: UpgradeProtocolRangeSchema,
    dataFormats: z.array(z.literal('project-name-v2-authority')).optional(),
  })
  .passthrough();
export const UpgradeComponentsSchema = z
  .object({
    api: UpgradeArtifactSchema,
    web: UpgradeArtifactSchema.extend({ webRevision: Revision }),
    installer: UpgradeArtifactSchema,
    coordinator: UpgradeArtifactSchema.optional(),
    owner: UpgradeArtifactSchema.optional(),
  })
  .passthrough();
export const UpgradePackageSchema = z
  .object({
    platform: z.enum(['linux', 'darwin']),
    arch: z.enum(['arm64', 'x64']),
    name: Name,
    url: z.string().url(),
    digest: Digest,
    bytes: z.number().int().positive(),
    format: z.enum(['native-tar', 'oci-tar']),
  })
  .passthrough();
export const UpgradePathSchema = z
  .object({
    fromRelease: Release,
    minSchema: z.number().int().nonnegative(),
    maxSchema: z.number().int().nonnegative(),
    targetSchema: z.number().int().nonnegative(),
    bridgeReleases: z.array(Release),
    migrationPlanDigest: Digest.nullable(),
  })
  .passthrough();
export const UpgradePolicySchema = z
  .object({
    id: Name,
    weights: z.tuple([z.literal(1), z.literal(5), z.literal(25), z.literal(100)]),
    stageDurationMs: z.number().int().min(60_000),
    minRequests: z.number().int().min(100),
    observationFreshnessMs: z.number().int().positive().max(5000),
    probeHz: z.number().min(10),
    requestDeadlineMs: z.number().positive().max(2000),
    attachDeadlineMs: z.number().positive().max(5000),
    softErrorDelta: z.number().min(0).max(0.01),
    p95Ratio: z.number().positive().max(2),
    p95FloorMs: z.number().positive().max(1000),
    evaluationIntervalMs: z.number().positive().max(10_000),
    consecutiveEvaluations: z.number().int().min(2),
    retentionMs: z.number().int().positive(),
    migrationBatchMs: z.number().int().positive(),
    maxWalBytes: z.number().int().positive(),
    minFreeBytes: z.number().int().positive(),
    fallbacks: z
      .array(
        z
          .object({
            releaseId: Release,
            apiDigest: Digest,
            webDigest: Digest,
            rehearsed: z.boolean(),
          })
          .passthrough(),
      )
      .min(1),
    stopUserResources: z.literal(false),
    restoreLiveVolume: z.literal(false),
    contractInUpgrade: z.literal(false),
  })
  .passthrough();
/** Separately signed semantic contraction; ordinary installation never executes it. */
export const UpgradeContractPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('project-name-contract'),
    planDigest: Digest,
    expandPlanDigest: Digest,
    targetTable: z.string().regex(/^upg_shadow_[a-z0-9_]{1,64}$/),
    nameColumn: z.string().regex(/^[a-z][a-z0-9_]{0,80}$/),
    artifactInputFingerprint: Digest,
    rollbackWindowMs: z.number().int().min(60000),
    maxValidationRows: z.number().int().positive().max(10000),
    maxBatchRows: z.number().int().positive().max(1000),
    batchBudgetMs: z.number().int().positive().max(1000),
    minFreeBytes: z.number().int().positive(),
    maxWalBytes: z.number().int().positive(),
    preserveUserResources: z.literal(true),
    rollbackToLegacy: z.literal(false),
  })
  .strict();
export const UpgradeContractRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    targetPlanDigest: Digest,
    expectedActivationGeneration: z.number().int().nonnegative(),
    acknowledgeRollbackClosure: z.literal(true),
  })
  .strict();
export const UpgradeContractAttemptSchema = z.object({
  instanceId: Name,
  contractAttemptId: z.string().uuid(),
  requestId: z.string().uuid(),
  targetPlanDigest: Digest,
  activationGeneration: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  state: z.enum([
    'accepted',
    'retiring-readers',
    'authority-active',
    'clearing',
    'completed',
    'deferred',
    'failed',
    'unknown',
  ]),
  stage: z.string(),
  completedRows: z.number().int().nonnegative(),
  totalRows: z.number().int().nonnegative().nullable(),
  acceptedAt: Time,
  observedAt: Time,
  reason: z.string().nullable(),
});
export const UpgradeContractStatusSchema = z.object({
  authority: z.enum(['legacy', 'new', 'unknown']),
  availablePlan: z
    .object({
      planDigest: Digest,
      releaseId: Release,
      expandPlanDigest: Digest,
      rollbackWindowClosesAt: Time,
      eligible: z.boolean(),
      reason: z.string().nullable(),
      legacyReaderCount: z.number().int().nonnegative(),
      irreversible: z.literal(true),
    })
    .nullable(),
  attempt: UpgradeContractAttemptSchema.nullable(),
});
export const UpgradeManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    releaseId: Release,
    channel: Name,
    publishedAt: Time,
    purpose: z.enum(['release', 'qualification']).optional(),
    qualification: z.object({ instanceId: Name, inputFingerprint: Digest }).optional(),
    withdrawn: z.boolean().optional(),
    commits: z.object({ project: Revision, api: Revision, web: Revision }).passthrough(),
    components: UpgradeComponentsSchema.extend({ coordinator: UpgradeArtifactSchema }),
    packages: z.array(UpgradePackageSchema).min(1).max(16),
    upgradePaths: z.array(UpgradePathSchema).min(1),
    policy: UpgradePolicySchema,
    evidence: z.array(
      z
        .object({
          kind: Name,
          result: z.enum(['passed', 'failed', 'partial', 'not-run', 'qualification']),
          inputFingerprint: Digest,
          reportDigest: Digest,
          runId: Name,
          recordedAt: Time,
        })
        .passthrough(),
    ),
    contractPlans: z.array(UpgradeContractPlanSchema).max(16).optional(),
  })
  .passthrough();
export const SignedUpgradeManifestSchema = z.object({
  manifest: UpgradeManifestSchema,
  manifestDigest: Digest,
  signature: z.object({ algorithm: z.literal('Ed25519'), keyId: Name, value: z.string().min(1) }),
});
export const UpgradeTrustRootSchema = z.object({
  schemaVersion: z.literal(1),
  channel: Name,
  distributionOrigins: z.array(z.string().url()).min(1),
  purpose: z.enum(['release', 'qualification']).optional(),
  qualificationInstanceId: Name.optional(),
  keys: z
    .array(
      z.object({
        id: Name,
        publicKey: z.string().min(1),
        revoked: z.boolean().optional(),
        notBefore: Time.optional(),
        notAfter: Time.optional(),
      }),
    )
    .min(1),
});
export const UpgradeStepSchema = z.object({
  stepId: Name,
  kind: z.enum([
    'download',
    'verify',
    'installer-handoff',
    'migration',
    'owner-candidate',
    'candidate',
    'coordinator-handoff',
    'route',
    'observe',
    'web',
    'activation',
  ]),
  totalWork: z.number().nonnegative().nullable(),
  artifactName: Name.optional(),
  planDigest: Digest.optional(),
  weight: z.number().optional(),
});
export const UpgradePlanSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: Release,
  manifestDigest: Digest,
  package: UpgradePackageSchema,
  migrationPath: UpgradePathSchema,
  apiReused: z.boolean(),
  webReused: z.boolean(),
  policy: UpgradePolicySchema,
  coordinatorReused: z.boolean(),
  ownerReused: z.boolean(),
  sourceCoordinatorDigest: Digest,
  sourceOwnerDigest: Digest.nullable(),
  installerReused: z.boolean(),
  sourceInstallerDigest: Digest,
  sourceInstallerInputFingerprint: Digest,
  steps: z.array(UpgradeStepSchema).min(1),
  sourceActivationGeneration: z.number().int().nonnegative(),
  sourceApiDigest: Digest,
  sourceWebDigest: Digest,
  planDigest: Digest,
});
export const UpgradeRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    targetReleaseId: Release,
    targetDigest: Digest,
    expectedActivationGeneration: z.number().int().nonnegative(),
  })
  .strict();
/** Deprecated rolling-compatibility request: instance access already authorizes upgrades. */
export const UpgradeAccessSchema = z
  .object({ upgradeKey: z.string().max(512).optional() })
  .strict();
export const UpgradeAttemptStateSchema = z.enum([
  'accepted',
  'downloading',
  'package-verified',
  'migrating',
  'prepared',
  'candidate-ready',
  'routing-switched',
  'observing',
  'api-activated',
  'activation-confirmed',
  'deferred',
  'candidate-rejected',
  'failed',
  'reverted',
]);
export const UpgradeAttemptSchema = z.object({
  instanceId: Name,
  attemptId: z.string().uuid(),
  requestId: z.string().uuid(),
  targetReleaseId: Release,
  targetDigest: Digest,
  generation: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  state: UpgradeAttemptStateSchema,
  stage: z.string(),
  percent: z.number().min(0).max(100).nullable(),
  completedWork: z.number().nonnegative(),
  totalWork: z.number().nonnegative().nullable(),
  planDigest: Digest,
  acceptedAt: Time,
  observedAt: Time,
  reason: z.string().nullable(),
});
export const ConfirmedServiceReleaseSchema = z.object({
  releaseId: Release,
  activationGeneration: z.number().int().nonnegative(),
  activatedAt: Time,
  schema: z.number().int().nonnegative(),
  channel: Name,
  components: UpgradeComponentsSchema,
  commits: z.object({ project: Revision, api: Revision, web: Revision }),
  productionWebBinding: z.string().min(1),
});
export const UpgradeRecoverySchema = z.object({
  recoveryAttemptId: z.string().uuid(),
  triggeringAttemptId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  state: z.enum(['recovering', 'recovery-confirmed', 'unknown', 'failed']),
  planDigest: Digest,
  reason: z.string(),
  observedAt: Time,
});
/** Private measured installation tuple. It does not assert a complete release. */
export const UpgradeSourceActualSchema = z.object({
  schemaVersion: z.literal(1),
  qualified: z.literal(true),
  partial: z.literal(true),
  instanceId: Name,
  baseConfirmedReleaseId: Release,
  activationGeneration: z.number().int().nonnegative(),
  schema: z.number().int().nonnegative(),
  components: UpgradeComponentsSchema,
  proofDigest: Digest,
  observedAt: Time,
});
export const UpgradeStatusSchema = z.object({
  instanceId: Name,
  userScope: z.string().min(1),
  activationGeneration: z.number().int().nonnegative(),
  confirmedServiceRelease: ConfirmedServiceReleaseSchema.nullable(),
  lastConfirmedServiceRelease: ConfirmedServiceReleaseSchema.nullable(),
  serviceState: z.enum(['confirmed', 'transitioning', 'unknown']),
  catalog: z.object({
    state: z.enum(['verified', 'unknown', 'unavailable', 'no-update']),
    observedAt: Time.nullable(),
    reason: z.string().nullable(),
    availableRelease: z
      .object({
        releaseId: Release,
        targetDigest: Digest,
        webRevision: Revision,
        webArtifactDigest: Digest,
        installable: z.literal(true),
      })
      .nullable(),
  }),
  capabilities: z.object({
    canUpgradeInstance: z.boolean(),
    canAuthenticate: z.boolean(),
    canContract: z.boolean().optional(),
  }),
  csrfToken: z.string(),
  attempt: UpgradeAttemptSchema.nullable(),
  recovery: UpgradeRecoverySchema.nullable(),
  availableWeb: z
    .object({
      releaseId: Release,
      webReleaseId: Release.nullable(),
      webRevision: Revision,
      artifactDigest: Digest,
      instanceId: Name,
      activationGeneration: z.number().int().nonnegative(),
      productionBinding: z.string(),
      ready: z.literal(true),
      compatible: z.literal(true),
      observedAt: Time,
    })
    .nullable(),
  observedAt: Time,
  repairableCurrent: z
    .object({
      baseConfirmedReleaseId: Release,
      activationGeneration: z.number().int().nonnegative(),
      observedAt: Time,
    })
    .nullable()
    .optional(),
  contract: UpgradeContractStatusSchema.nullable().optional(),
});

export type UpgradeManifest = z.infer<typeof UpgradeManifestSchema>;
export type SignedUpgradeManifest = z.infer<typeof SignedUpgradeManifestSchema>;
export type UpgradeTrustRoot = z.infer<typeof UpgradeTrustRootSchema>;
export type UpgradePlan = z.infer<typeof UpgradePlanSchema>;
export type UpgradeRequest = z.infer<typeof UpgradeRequestSchema>;
export type UpgradeAttempt = z.infer<typeof UpgradeAttemptSchema>;
export type UpgradeStatus = z.infer<typeof UpgradeStatusSchema>;
export type ConfirmedServiceRelease = z.infer<typeof ConfirmedServiceReleaseSchema>;
export type UpgradeRecovery = z.infer<typeof UpgradeRecoverySchema>;
export type UpgradeSourceActual = z.infer<typeof UpgradeSourceActualSchema>;
export type UpgradeContractPlan = z.infer<typeof UpgradeContractPlanSchema>;
export type UpgradeContractRequest = z.infer<typeof UpgradeContractRequestSchema>;
export type UpgradeContractAttempt = z.infer<typeof UpgradeContractAttemptSchema>;
export type UpgradeContractStatus = z.infer<typeof UpgradeContractStatusSchema>;
