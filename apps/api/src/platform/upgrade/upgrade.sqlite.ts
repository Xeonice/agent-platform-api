import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/sqlite-core';

/** Durable Coordinator-owned upgrade, authority, intent and projection schema. */
export const upgradeInstances = sqliteTable('upgrade_instances', {
  instanceId: text('instance_id').primaryKey().notNull(),
  activationGeneration: integer('activation_generation')
    .notNull()
    .default(sql`0`),
  confirmedRelease: text('confirmed_release'),
  serviceState: text('service_state')
    .notNull()
    .default(sql`'unknown'`),
  ready: integer('ready')
    .notNull()
    .default(sql`0`),
  updatedAt: integer('updated_at').notNull(),
});

export const upgradeAttempts = sqliteTable(
  'upgrade_attempts',
  {
    attemptId: text('attempt_id').primaryKey().notNull(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => upgradeInstances.instanceId),
    actorId: text('actor_id').notNull(),
    requestId: text('request_id').notNull(),
    requestDigest: text('request_digest').notNull(),
    targetReleaseId: text('target_release_id').notNull(),
    targetDigest: text('target_digest').notNull(),
    manifest: text('manifest').notNull(),
    plan: text('plan').notNull(),
    sourceActivation: text('source_activation').notNull(),
    sourceActual: text('source_actual'),
    generation: integer('generation').notNull(),
    sequence: integer('sequence')
      .notNull()
      .default(sql`0`),
    state: text('state')
      .notNull()
      .default(sql`'accepted'`),
    stage: text('stage')
      .notNull()
      .default(sql`'accepted'`),
    reason: text('reason'),
    controllerId: text('controller_id'),
    fence: integer('fence')
      .notNull()
      .default(sql`0`),
    leaseExpiresAt: integer('lease_expires_at')
      .notNull()
      .default(sql`0`),
    acceptedAt: integer('accepted_at').notNull(),
    observedAt: integer('observed_at').notNull(),
  },
  (t) => ({
    upgradeOneActiveAttempt: uniqueIndex('upgrade_one_active_attempt')
      .on(t.instanceId)
      .where(
        sql`"state" IN ('accepted','downloading','package-verified','migrating','prepared','candidate-ready','routing-switched','observing','api-activated')`,
      ),
    upgradeAttemptsInstanceIdActorIdRequestIdUnique: uniqueIndex(
      'upgrade_attempts_instance_id_actor_id_request_id_unique',
    ).on(t.instanceId, t.actorId, t.requestId),
  }),
);

export const upgradeEvents = sqliteTable(
  'upgrade_events',
  {
    eventId: text('event_id').primaryKey().notNull(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => upgradeAttempts.attemptId),
    eventDigest: text('event_digest').notNull(),
    generation: integer('generation').notNull(),
    sequence: integer('sequence').notNull(),
    fence: integer('fence').notNull(),
    kind: text('kind').notNull(),
    payload: text('payload').notNull(),
    recordedAt: integer('recorded_at').notNull(),
  },
  (t) => ({
    upgradeEventsAttemptIdSequenceUnique: uniqueIndex(
      'upgrade_events_attempt_id_sequence_unique',
    ).on(t.attemptId, t.sequence),
  }),
);

export const upgradeSteps = sqliteTable(
  'upgrade_steps',
  {
    attemptId: text('attempt_id')
      .notNull()
      .references(() => upgradeAttempts.attemptId),
    stepId: text('step_id').notNull(),
    completedWork: real('completed_work')
      .notNull()
      .default(sql`0`),
    applied: integer('applied')
      .notNull()
      .default(sql`0`),
    receiptDigest: text('receipt_digest'),
    evidence: text('evidence'),
    appliedAt: integer('applied_at'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.attemptId, t.stepId] }) }),
);

export const upgradeRecoveries = sqliteTable('upgrade_recoveries', {
  recoveryAttemptId: text('recovery_attempt_id').primaryKey().notNull(),
  triggeringAttemptId: text('triggering_attempt_id')
    .notNull()
    .references(() => upgradeAttempts.attemptId),
  instanceId: text('instance_id')
    .notNull()
    .references(() => upgradeInstances.instanceId),
  generation: integer('generation').notNull(),
  sequence: integer('sequence').notNull(),
  state: text('state').notNull(),
  plan: text('plan').notNull(),
  planDigest: text('plan_digest').notNull(),
  reason: text('reason').notNull(),
  observedAt: integer('observed_at').notNull(),
});

export const platformRoleLeases = sqliteTable('platform_role_leases', {
  role: text('role').primaryKey().notNull(),
  instanceId: text('instance_id').notNull(),
  holderId: text('holder_id').notNull(),
  generation: integer('generation').notNull(),
  fence: integer('fence').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const platformOperations = sqliteTable('platform_operations', {
  operationId: text('operation_id').primaryKey().notNull(),
  instanceId: text('instance_id').notNull(),
  actorId: text('actor_id').notNull(),
  role: text('role').notNull(),
  fence: integer('fence').notNull(),
  requestDigest: text('request_digest').notNull(),
  state: text('state').notNull(),
  result: text('result'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const agentTaskStartIntents = sqliteTable('agent_task_start_intents', {
  taskId: text('task_id').primaryKey().notNull(),
  sandboxId: text('sandbox_id').notNull(),
  provider: text('provider').notNull(),
  payload: text('payload').notNull(),
  state: text('state')
    .notNull()
    .default(sql`'pending'`),
  createdAt: integer('created_at').notNull(),
});

export const sandboxCreateIntents = sqliteTable(
  'sandbox_create_intents',
  {
    sandboxId: text('sandbox_id').primaryKey().notNull(),
    operationId: text('operation_id').notNull(),
    requestDigest: text('request_digest').notNull(),
    workspacePath: text('workspace_path').notNull(),
    state: text('state')
      .notNull()
      .default(sql`'pending'`),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    sandboxCreateIntentsOperationIdUnique: uniqueIndex(
      'sandbox_create_intents_operation_id_unique',
    ).on(t.operationId),
  }),
);

export const terminalBookmarks = sqliteTable(
  'terminal_bookmarks',
  {
    terminalIdentity: text('terminal_identity').primaryKey().notNull(),
    sandboxId: text('sandbox_id').notNull(),
    kind: text('kind').notNull(),
    privateSessionId: text('private_session_id').notNull(),
    runtimeId: text('runtime_id'),
    runtimeIdentity: text('runtime_identity'),
    closeRequestedAt: integer('close_requested_at'),
  },
  (t) => ({
    terminalBookmarksSandboxIdKindPrivateSessionIdUnique: uniqueIndex(
      'terminal_bookmarks_sandbox_id_kind_private_session_id_unique',
    ).on(t.sandboxId, t.kind, t.privateSessionId),
  }),
);

export const upgradeContinuityBaselines = sqliteTable('upgrade_continuity_baselines', {
  attemptId: text('attempt_id')
    .primaryKey()
    .notNull()
    .references(() => upgradeAttempts.attemptId),
  snapshot: text('snapshot').notNull(),
  digest: text('digest').notNull(),
  capturedAt: integer('captured_at').notNull(),
});

export const upgradeProbeRecords = sqliteTable('upgrade_probe_records', {
  requestId: text('request_id').primaryKey().notNull(),
  attemptId: text('attempt_id').notNull(),
  value: text('value').notNull(),
  revision: integer('revision').notNull(),
  committedAt: integer('committed_at').notNull(),
});

export const coordinatorHandoffs = sqliteTable(
  'coordinator_handoffs',
  {
    attemptId: text('attempt_id').primaryKey().notNull(),
    operationId: text('operation_id').notNull(),
    planDigest: text('plan_digest').notNull(),
    candidate: text('candidate').notNull(),
    stage: text('stage').notNull(),
    sourceGeneration: integer('source_generation').notNull(),
    targetGeneration: integer('target_generation'),
    quiescedAt: integer('quiesced_at'),
    activatedAt: integer('activated_at'),
    evidence: text('evidence'),
  },
  (t) => ({
    coordinatorHandoffsOperationIdUnique: uniqueIndex(
      'coordinator_handoffs_operation_id_unique',
    ).on(t.operationId),
  }),
);

export const upgradeRoleHandoffs = sqliteTable(
  'upgrade_role_handoffs',
  {
    attemptId: text('attempt_id').notNull(),
    kind: text('kind').notNull(),
    operationId: text('operation_id').notNull(),
    planDigest: text('plan_digest').notNull(),
    candidate: text('candidate').notNull(),
    stage: text('stage').notNull(),
    evidence: text('evidence').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.attemptId, t.kind] }),
    upgradeRoleHandoffsOperationIdUnique: uniqueIndex(
      'upgrade_role_handoffs_operation_id_unique',
    ).on(t.operationId),
  }),
);

export const upgradeObservations = sqliteTable(
  'upgrade_observations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }).notNull(),
    attemptId: text('attempt_id').notNull(),
    weight: integer('weight').notNull(),
    routeGeneration: integer('route_generation').notNull(),
    coordinatorGeneration: integer('coordinator_generation').notNull(),
    observedAt: integer('observed_at').notNull(),
    latencyMs: real('latency_ms').notNull(),
    success: integer('success').notNull(),
    requestId: text('request_id').notNull(),
    evidenceDigest: text('evidence_digest').notNull(),
  },
  (t) => ({
    upgradeObservationWindow: index('upgrade_observation_window').on(
      t.attemptId,
      t.weight,
      t.observedAt,
    ),
  }),
);

export const upgradeAttachmentObservations = sqliteTable(
  'upgrade_attachment_observations',
  {
    attemptId: text('attempt_id').notNull(),
    sandboxId: text('sandbox_id').notNull(),
    runtimeIdentity: text('runtime_identity').notNull(),
    durationMs: real('duration_ms').notNull(),
    observedAt: integer('observed_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.attemptId, t.sandboxId] }) }),
);

export const upgradeOnlineMigrations = sqliteTable('upgrade_online_migrations', {
  planDigest: text('plan_digest').primaryKey().notNull(),
  attemptId: text('attempt_id').notNull(),
  plan: text('plan').notNull(),
  stage: text('stage').notNull(),
  checkpoint: text('checkpoint').notNull(),
  completedWork: integer('completed_work')
    .notNull()
    .default(sql`0`),
  readEpoch: integer('read_epoch')
    .notNull()
    .default(sql`0`),
  degraded: integer('degraded')
    .notNull()
    .default(sql`0`),
  reason: text('reason'),
  updatedAt: integer('updated_at').notNull(),
});

export const upgradeProjectionChanges = sqliteTable(
  'upgrade_projection_changes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }).notNull(),
    planDigest: text('plan_digest').notNull(),
    projection: text('projection').notNull(),
    rowKey: text('row_key').notNull(),
    payload: text('payload'),
    tombstone: integer('tombstone').notNull(),
    projected: integer('projected')
      .notNull()
      .default(sql`0`),
  },
  (t) => ({
    upgradeProjectionPending: index('upgrade_projection_pending').on(
      t.planDigest,
      t.projected,
      t.id,
    ),
  }),
);

export const upgradeSchemaEpochs = sqliteTable('upgrade_schema_epochs', {
  singleton: integer('singleton').primaryKey().notNull(),
  schemaVersion: integer('schema_version').notNull(),
});

export const upgradeMigrationOperations = sqliteTable('upgrade_migration_operations', {
  operationId: text('operation_id').primaryKey().notNull(),
  requestDigest: text('request_digest').notNull(),
  result: text('result').notNull(),
});

export const coordinatorRecoveries = sqliteTable(
  'coordinator_recoveries',
  {
    recoveryAttemptId: text('recovery_attempt_id').primaryKey().notNull(),
    triggeringAttemptId: text('triggering_attempt_id').notNull(),
    operationId: text('operation_id').notNull(),
    planDigest: text('plan_digest').notNull(),
    candidate: text('candidate').notNull(),
    stage: text('stage').notNull(),
    sourceGeneration: integer('source_generation').notNull(),
    targetGeneration: integer('target_generation'),
    quiescedAt: integer('quiesced_at'),
    activatedAt: integer('activated_at'),
    evidence: text('evidence'),
  },
  (t) => ({
    coordinatorRecoveriesOperationIdUnique: uniqueIndex(
      'coordinator_recoveries_operation_id_unique',
    ).on(t.operationId),
  }),
);

export const agentTaskJobCompletions = sqliteTable(
  'agent_task_job_completions',
  {
    taskId: text('task_id').primaryKey().notNull(),
    sandboxId: text('sandbox_id').notNull(),
    provider: text('provider').notNull(),
    jobHandleDigest: text('job_handle_digest').notNull(),
    cursor: text('cursor'),
    lastSeq: integer('last_seq').notNull(),
    exitCode: integer('exit_code'),
    exitKind: text('exit_kind').notNull(),
    observedAt: integer('observed_at').notNull(),
    evidenceDigest: text('evidence_digest').notNull(),
  },
  (t) => ({
    seq: check('agent_task_job_completions_seq_ck', sql`${t.lastSeq}>=0`),
    kind: check(
      'agent_task_job_completions_kind_ck',
      sql`${t.exitKind} IN ('natural','timeout','cancelled')`,
    ),
  }),
);
