import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { UuidIdGenerator } from '../time/uuid-id-generator';
import { mkdirSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { UpgradeStore } from './upgrade-store';
import type { Clock } from '@platform/shared-kernel';
import { z } from 'zod';
import { canonicalUpgrade, requireUpgrade, upgradeDigest, UpgradeError } from './upgrade-trust';
import { upgradeRecord } from './upgrade-values';
import { withoutUpgradeRecovery } from '../persistence/upgrade-recovery-context';

type Method = 'coordinatorHandoff' | 'ownerCandidate' | 'migration';
type Headers = Record<string, string | string[] | undefined>;
const paths = {
  coordinatorHandoff: 'coordinator-handoff',
  ownerCandidate: 'owner-candidate',
  migration: 'migration',
};
const Spec = z
  .object({
    schemaVersion: z.literal(1),
    method: z.enum(['coordinatorHandoff', 'ownerCandidate', 'migration']),
    path: z.string().max(1024),
    attemptId: z.string().uuid(),
    participant: z
      .object({
        startIdentity: z.string().min(1).max(180),
        artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict(),
    body: z.record(z.unknown()),
    originalFence: z.number().int().positive(),
    deadline: z.number().int().positive(),
  })
  .strict();
interface Command {
  instanceId: string;
  attemptId: string;
  commandId: string;
  specDigest: string;
  spec: z.infer<typeof Spec>;
  epoch: number;
}
interface ActionContext {
  store: UpgradeStore;
  clock: Clock;
  command: Command;
  fence: number;
}
const contexts = new AsyncLocalStorage<ActionContext>();
const active = new Map<string, Promise<Record<string, unknown>>>();
function key(command: Command): string {
  return command.instanceId + ':' + command.attemptId + ':' + command.commandId;
}
function load(store: UpgradeStore, id: string, commandId: string): Command {
  requireUpgrade(/^[a-zA-Z0-9._:-]{1,200}$/.test(commandId), 'CONTROL_COMMAND_ID_INVALID');
  const row = store.ledgerSqlite
    .prepare<unknown[], { spec: string; spec_digest: string; epoch: number }>(
      'SELECT spec,spec_digest,epoch FROM control_commands WHERE instance_id=? AND operation_id=? AND command_id=?',
    )
    .get(store.instanceId, id, commandId);
  requireUpgrade(row, 'CONTROL_COMMAND_NOT_FOUND');
  const raw: unknown = JSON.parse(row.spec),
    parsed = Spec.safeParse(raw);
  requireUpgrade(
    parsed.success &&
      upgradeDigest(raw) === row.spec_digest &&
      parsed.data.attemptId === id &&
      parsed.data.path === '/internal/upgrades/' + id + '/' + paths[parsed.data.method],
    'CONTROL_BUSINESS_SPEC_INVALID',
  );
  return {
    instanceId: store.instanceId,
    attemptId: id,
    commandId,
    specDigest: row.spec_digest,
    spec: parsed.data,
    epoch: row.epoch,
  };
}
function factPath(command: Command, create = false): string {
  const binding = process.env.PLATFORM_COORDINATOR_BINDING_PATH;
  requireUpgrade(binding && isAbsolute(binding), 'PARTICIPANT_FACT_DIRECTORY_REQUIRED');
  const root = dirname(binding),
    stat = lstatSync(root);
  requireUpgrade(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      realpathSync(root) === root,
    'PARTICIPANT_FACT_DIRECTORY_INSECURE',
  );
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const base = join(root, 'upgrade-participant-facts');
  if (create && !existsDirectory(base)) mkdirSync(base, { mode: 0o700 });
  const baseStat = lstatSync(base);
  requireUpgrade(
    baseStat.isDirectory() &&
      !baseStat.isSymbolicLink() &&
      (baseStat.mode & 0o077) === 0 &&
      realpathSync(base) === base,
    'PARTICIPANT_FACT_DIRECTORY_INSECURE',
  );
  const dir = join(base, hash(command.spec.participant.startIdentity));
  if (create && !existsDirectory(dir)) mkdirSync(dir, { mode: 0o700 });
  const actual = lstatSync(dir);
  requireUpgrade(
    actual.isDirectory() &&
      !actual.isSymbolicLink() &&
      (actual.mode & 0o077) === 0 &&
      realpathSync(dir) === dir,
    'PARTICIPANT_FACT_DIRECTORY_INSECURE',
  );
  return join(dir, hash(key(command)) + '.json');
}
function existsDirectory(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
function readFact(command: Command): Record<string, unknown> | null {
  let bytes: string;
  try {
    const path = factPath(command),
      stat = lstatSync(path);
    requireUpgrade(
      stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size <= 300000,
      'PARTICIPANT_FACT_INSECURE',
    );
    bytes = readFileSync(path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
  const value = upgradeRecord(JSON.parse(bytes)),
    { receiptDigest, ...proof } = value;
  requireUpgrade(
    upgradeDigest(proof) === receiptDigest &&
      ['running', 'settled'].includes(String(value.state)) &&
      value.instanceId === command.instanceId &&
      value.attemptId === command.attemptId &&
      value.commandId === command.commandId &&
      value.specDigest === command.specDigest &&
      upgradeDigest(value.participant) === upgradeDigest(command.spec.participant) &&
      (value.result === undefined || upgradeDigest(value.result) === value.resultDigest),
    'PARTICIPANT_FACT_SCOPE_MISMATCH',
  );
  return value;
}
async function writeFact(command: Command, value: Record<string, unknown>): Promise<void> {
  const path = factPath(command, true),
    temp = path + '.' + new UuidIdGenerator().next(),
    proof = {
      ...value,
      instanceId: command.instanceId,
      attemptId: command.attemptId,
      commandId: command.commandId,
      specDigest: command.specDigest,
      participant: command.spec.participant,
    },
    receipt = { ...proof, receiptDigest: upgradeDigest(proof) };
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(canonicalUpgrade(receipt));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function assertCommand(context: ActionContext): void {
  const { store, clock, command, fence } = context;
  store.assertControllerFence(command.attemptId, fence);
  const row = store.ledgerSqlite
    .prepare<unknown[], { state: string; epoch: number; spec_digest: string }>(
      'SELECT state,epoch,spec_digest FROM control_commands WHERE instance_id=? AND operation_id=? AND command_id=?',
    )
    .get(command.instanceId, command.attemptId, command.commandId);
  requireUpgrade(
    row?.state === 'executing' &&
      row.epoch === fence &&
      row.spec_digest === command.specDigest &&
      command.spec.deadline > clock.now().getTime(),
    'CONTROL_BUSINESS_COMMAND_NOT_EXECUTING',
  );
}
export function assertCurrentBusinessAction(): void {
  const context = contexts.getStore();
  if (context) assertCommand(context);
}
export function assertBusinessActionMutation(): void {
  const context = contexts.getStore();
  if (!context) return;
  assertCommand(context);
  const local = context.store.sqlite
    .prepare<unknown[], { fence: number }>(
      "SELECT fence FROM platform_operations WHERE instance_id=? AND role='upgrade-control-admission' ORDER BY fence DESC LIMIT 1",
    )
    .get(context.store.instanceId);
  requireUpgrade(!local || local.fence <= context.fence, 'CONTROL_BUSINESS_PARTICIPANT_SUPERSEDED');
}
export function withoutBusinessAction<T>(work: () => T): T {
  return contexts.exit(work);
}
export async function withBusinessAction(
  store: UpgradeStore,
  clock: Clock,
  headers: Headers,
  id: string,
  method: Method,
  input: Record<string, unknown>,
  work: () => Promise<Record<string, unknown>>,
  preparedAdopt = false,
): Promise<Record<string, unknown>> {
  if (!store.ledgerReadonly) return work();
  const commandId = headers['x-platform-control-command-id'],
    specDigest = headers['x-platform-control-spec-digest'];
  requireUpgrade(
    typeof commandId === 'string' && typeof specDigest === 'string',
    'CONTROL_BUSINESS_COMMAND_REQUIRED',
  );
  const command = load(store, id, commandId),
    { fence: envelope, ...body } = input;
  requireUpgrade(
    command.specDigest === specDigest &&
      command.spec.method === method &&
      command.spec.participant.startIdentity === process.env.PLATFORM_PROCESS_START_IDENTITY &&
      command.spec.participant.artifactDigest === process.env.PLATFORM_ARTIFACT_DIGEST,
    'CONTROL_BUSINESS_PARTICIPANT_MISMATCH',
  );
  const expected = preparedAdopt
    ? {
        instanceId: store.instanceId,
        attemptId: id,
        operationId: command.spec.body.operationId,
        planDigest: command.spec.body.planDigest,
        startIdentity: command.spec.participant.startIdentity,
      }
    : command.spec.body;
  if (preparedAdopt) {
    const candidate = upgradeRecord(command.spec.body.candidate);
    requireUpgrade(
      candidate.startIdentity === command.spec.participant.startIdentity &&
        candidate.artifactDigest === command.spec.participant.artifactDigest,
      'CONTROL_BUSINESS_PARTICIPANT_MISMATCH',
    );
  }
  requireUpgrade(
    upgradeDigest(body) === upgradeDigest(expected) &&
      (!preparedAdopt || command.spec.body.action === 'adopt'),
    'CONTROL_BUSINESS_BODY_CHANGED',
  );
  const context = { store, clock, command, fence: Number(envelope) };
  assertCommand(context);
  const existing = active.get(key(command));
  if (existing) return existing;
  const prior = readFact(command);
  if (prior) {
    requireUpgrade(
      prior.state === 'settled' && prior.outcome === 'resolved' && prior.result,
      'CONTROL_BUSINESS_OUTCOME_UNKNOWN',
    );
    return upgradeRecord(prior.result);
  }
  const startedAt = clock.now().toISOString();
  const promise = contexts
    .run(context, async () => {
      await writeFact(command, { state: 'running', startedAt });
      assertCommand(context);
      try {
        const result = await work();
        const resultDigest = upgradeDigest(result),
          bounded = Buffer.byteLength(canonicalUpgrade(result)) <= 256 * 1024;
        // Finalization is facts only; it intentionally does not borrow an expired
        // controller or business writer lease. No business action follows it.
        await writeFact(command, {
          state: 'settled',
          outcome: 'resolved',
          startedAt,
          settledAt: clock.now().toISOString(),
          resultDigest,
          ...(bounded ? { result } : { resultUnavailable: true }),
        });
        return result;
      } catch (error) {
        await writeFact(command, {
          state: 'settled',
          outcome: 'rejected',
          startedAt,
          settledAt: clock.now().toISOString(),
          code: error instanceof UpgradeError ? error.code : 'BUSINESS_ACTION_REJECTED',
        });
        throw error;
      }
    })
    .finally(() => {
      active.delete(key(command));
    });
  active.set(key(command), promise);
  return promise;
}
export function readBusinessActionStatus(
  store: UpgradeStore,
  clock: Clock,
  id: string,
  commandId: string,
) {
  const command = load(store, id, commandId),
    own =
      command.spec.participant.startIdentity === process.env.PLATFORM_PROCESS_START_IDENTITY &&
      command.spec.participant.artifactDigest === process.env.PLATFORM_ARTIFACT_DIGEST;
  const receipt = readFact(command),
    running = own ? active.has(key(command)) : null;
  let admissionClosed = false;
  try {
    withoutUpgradeRecovery(() => {
      assertCommand({ store, clock, command, fence: command.epoch });
    });
  } catch (error) {
    // An unavailable ledger/driver is unknown, never proof that admission closed.
    admissionClosed =
      error instanceof UpgradeError &&
      [
        'UPGRADE_FENCE_EXPIRED',
        'UPGRADE_AUTHORITY_SUPERSEDED',
        'CONTROL_AUTHORITY_EXPIRED_OR_SUPERSEDED',
        'CONTROL_BUSINESS_COMMAND_NOT_EXECUTING',
        'CONTROLLER_CLAIM_REQUIRED',
      ].includes(error.code);
  }
  return {
    instanceId: store.instanceId,
    attemptId: id,
    commandId,
    specDigest: command.specDigest,
    participant: command.spec.participant,
    state: running
      ? 'running'
      : receipt?.state === 'settled'
        ? 'settled'
        : !receipt && own
          ? 'not-started'
          : 'unknown',
    actualRunning: running,
    admissionClosed,
    receipt,
  };
}
export function assertPendingBusinessActionsSettled(
  store: UpgradeStore,
  clock: Clock,
  id: string,
): void {
  const rows = store.ledgerSqlite
    .prepare<unknown[], { command_id: string }>(
      "SELECT command_id FROM control_commands WHERE instance_id=? AND operation_id=? AND state IN ('executing','unknown','blocked') LIMIT 101",
    )
    .all(store.instanceId, id);
  requireUpgrade(rows.length <= 100, 'CONTROL_PARTICIPANT_COMMAND_LIMIT');
  for (const row of rows) {
    const raw = store.ledgerSqlite
      .prepare<unknown[], { spec: string }>(
        'SELECT spec FROM control_commands WHERE instance_id=? AND operation_id=? AND command_id=?',
      )
      .get(store.instanceId, id, row.command_id);
    requireUpgrade(raw, 'CONTROL_COMMAND_NOT_FOUND');
    const spec = upgradeRecord(JSON.parse(raw.spec));
    if (!['coordinatorHandoff', 'ownerCandidate', 'migration'].includes(String(spec.method)))
      continue;
    const status = readBusinessActionStatus(store, clock, id, row.command_id);
    requireUpgrade(
      status.state === 'settled' && status.actualRunning === false && status.admissionClosed,
      'CONTROL_PREVIOUS_BUSINESS_ACTION_PENDING',
    );
  }
}
