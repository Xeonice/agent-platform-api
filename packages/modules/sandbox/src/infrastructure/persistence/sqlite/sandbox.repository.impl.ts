import { Inject, Injectable } from '@nestjs/common';
import { eq, ne, and, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { SandboxId, ProjectId, Tx } from '@platform/shared-kernel';
import { Sandbox } from '../../../domain/entities/sandbox.entity';
import { InitialTask } from '../../../domain/value-objects/initial-task.vo';
import type { SandboxStatus } from '../../../domain/value-objects/sandbox-status.vo';
import type { TriggeredBy } from '../../../domain/entities/state-transition.entity';
import {
  isProjectTaskActive,
  type SandboxRepository,
  type DeletedProjectSandbox,
  type SandboxImageReference,
} from '../../../domain/repositories/sandbox.repository';
import {
  SandboxWriteConflictError,
  SandboxProjectHasActiveTasksError,
} from '../../../domain/errors/write-conflict.error';
import {
  sandboxes,
  sandboxStateTransitions,
  sandboxProjectCleanupJobs,
  type SandboxRow,
  type SandboxTransitionRow,
} from '../schema/sandbox.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * SQLite (better-sqlite3 + Drizzle) implementation of the SandboxRepository port.
 * `saveSync` is synchronous (P0-2): better-sqlite3 statements run synchronously,
 * so the whole write completes inside the UnitOfWork's sync transaction.
 * snake_case ↔ camelCase and Date mapping happen here (28 §4 boundary rule).
 */
@Injectable()
export class SqliteSandboxRepository implements SandboxRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async findImageReferences(manifestId: string): Promise<SandboxImageReference[]> {
    // A narrow projection via the sandbox application facade, without importing project internals.
    return this.db
      .all<SandboxImageReference>(
        sql`
      select s.id, s.name, s.status, s.project_id as projectId,
             coalesce(p.name, '项目已删除') as projectName, s.headless
      from sandboxes s left join projects p on p.id = s.project_id
      where s.image_ref = ${manifestId} and s.status != 'destroyed'
      order by s.created_at, s.id
    `,
      )
      .map((row) => ({ ...row, headless: Boolean(row.headless) }));
  }

  async findById(id: SandboxId): Promise<Sandbox | null> {
    const row = this.db.select().from(sandboxes).where(eq(sandboxes.id, id)).get();
    if (!row) return null;
    const transitions = this.db
      .select()
      .from(sandboxStateTransitions)
      .where(eq(sandboxStateTransitions.sandboxId, id))
      .orderBy(sql`${sandboxStateTransitions}.rowid`)
      .all();
    return this.toDomain(row, transitions);
  }

  async findByProject(projectId: ProjectId): Promise<Sandbox[]> {
    const rows = this.db.select().from(sandboxes).where(eq(sandboxes.projectId, projectId)).all();
    return rows.map((row) => {
      const transitions = this.db
        .select()
        .from(sandboxStateTransitions)
        .where(eq(sandboxStateTransitions.sandboxId, row.id))
        .orderBy(sql`${sandboxStateTransitions}.rowid`)
        .all();
      return this.toDomain(row, transitions);
    });
  }

  async findAll(): Promise<Sandbox[]> {
    const rows = this.db.select().from(sandboxes).all();
    return rows.map((row) => {
      const transitions = this.db
        .select()
        .from(sandboxStateTransitions)
        .where(eq(sandboxStateTransitions.sandboxId, row.id))
        .orderBy(sql`${sandboxStateTransitions}.rowid`)
        .all();
      return this.toDomain(row, transitions);
    });
  }

  async countActiveByProject(projectIds: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const id of projectIds) out[id] = 0; // ensure every requested id is present
    if (projectIds.length === 0) return out;
    const rows = this.db
      .select({ projectId: sandboxes.projectId, n: sql<number>`count(*)` })
      .from(sandboxes)
      .where(and(inArray(sandboxes.projectId, projectIds), ne(sandboxes.status, 'destroyed')))
      .groupBy(sandboxes.projectId)
      .all();
    for (const row of rows) out[row.projectId] = row.n;
    return out;
  }

  deleteByProjectSync(_tx: Tx, projectId: ProjectId): DeletedProjectSandbox[] {
    const rows = this.db.select().from(sandboxes).where(eq(sandboxes.projectId, projectId)).all();
    const active = rows.filter((row) => isProjectTaskActive(row.status));
    if (active.length > 0)
      throw new SandboxProjectHasActiveTasksError(
        active.map((row) => ({ id: row.id, name: row.name ?? row.id })),
      );
    for (const row of rows) {
      this.db
        .insert(sandboxProjectCleanupJobs)
        .values({
          sandboxId: row.id,
          provider: row.provider,
          providerSandboxId: row.providerHandle,
          providerState: row.providerState,
          workspacePath: row.workspacePath,
        })
        .onConflictDoNothing()
        .run();
    }
    this.db.delete(sandboxes).where(eq(sandboxes.projectId, projectId)).run();
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      providerSandboxId: row.providerHandle,
      providerState: decodeProviderState(row.providerState),
      workspacePath: row.workspacePath,
    }));
  }

  async listPendingProjectCleanup(): Promise<DeletedProjectSandbox[]> {
    return this.db
      .select()
      .from(sandboxProjectCleanupJobs)
      .all()
      .map((row) => ({
        id: row.sandboxId,
        provider: row.provider,
        providerSandboxId: row.providerSandboxId,
        providerState: decodeProviderState(row.providerState),
        workspacePath: row.workspacePath,
      }));
  }

  completeProjectCleanupSync(_tx: Tx, sandboxId: string): void {
    this.db
      .delete(sandboxProjectCleanupJobs)
      .where(eq(sandboxProjectCleanupJobs.sandboxId, sandboxId))
      .run();
  }

  saveSync(_tx: Tx, sandbox: Sandbox): void {
    // The injected connection is already inside the active UnitOfWork transaction
    // (better-sqlite3 is single-connection + synchronous), so we write on it
    // directly; `_tx` is only the marker gating this call (28 §7.3).
    const db = this.db;
    const history = sandbox.transitions;
    if (history.length === 0) {
      // an aggregate always carries at least its creation transition (28 §2.2)
      throw new Error('cannot persist a sandbox with no transition history');
    }
    const createdAt = history[0].at;
    const updatedAt = history[history.length - 1].at;

    const existing = db
      .select({ version: sandboxes.version })
      .from(sandboxes)
      .where(eq(sandboxes.id, sandbox.id))
      .get();
    if (existing && existing.version !== sandbox.version) throw new SandboxWriteConflictError();
    // A stale aggregate must never reinsert a row already removed with its project.
    if (!existing && !sandbox.pendingTransitions.some((t) => t.from === null))
      throw new SandboxWriteConflictError();
    const version = existing ? sandbox.version + 1 : sandbox.version;
    const result = db
      .insert(sandboxes)
      .values({
        id: sandbox.id as string,
        projectId: sandbox.projectId as string,
        name: sandbox.name,
        runtime: sandbox.runtime,
        // `''` ⇒ NULL, not the empty string: `image_ref` is a foreign key since 0010
        // and `''` is a VALUE, so it would fail the constraint rather than mean
        // 「no manifest」. The domain models 「none」 as `''` because the aggregate's
        // field is non-optional; the boundary is where that becomes SQL's NULL.
        imageRef: sandbox.imageRef === '' ? null : sandbox.imageRef,
        provider: sandbox.provider,
        status: sandbox.status,
        headless: sandbox.headless,
        timeoutMinutes: sandbox.timeoutMinutes,
        idleTimeoutSec: sandbox.idleTimeoutSec,
        providerHandle: sandbox.providerSandboxId,
        workspacePath: sandbox.workspacePath,
        providerState: encodeProviderState(sandbox.providerState),
        injectedRuntimes: encodeInjectedRuntimes(sandbox.injectedRuntimes),
        initialPrompt: sandbox.initialTask.prompt ?? null,
        initialPromptConsumedAt: sandbox.initialTask.consumedAt ?? null,
        failureCode: sandbox.failureCode,
        failureReason: sandbox.failureReason,
        failureOperation: sandbox.failureOperation,
        sourceAutomationId: sandbox.sourceAutomationId,
        sourceAutomationName: sandbox.sourceAutomationName,
        artifactRetentionDays: sandbox.artifactRetentionDays,
        automationFinishedAt: sandbox.automationFinishedAt,
        version,
        createdAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: sandboxes.id,
        setWhere: eq(sandboxes.version, sandbox.version),
        set: {
          name: sandbox.name,
          status: sandbox.status,
          timeoutMinutes: sandbox.timeoutMinutes,
          idleTimeoutSec: sandbox.idleTimeoutSec,
          providerHandle: sandbox.providerSandboxId,
          workspacePath: sandbox.workspacePath,
          providerState: encodeProviderState(sandbox.providerState),
          // provision/restart 跑完 ④ 之后会落账（覆盖，不是并集 —— 见
          // `Sandbox.recordInjectedRuntimes`）。
          injectedRuntimes: encodeInjectedRuntimes(sandbox.injectedRuntimes),
          // the instruction itself never changes after T1; only its consumed marker
          // moves (once, forward) — see I-SBX-10.
          initialPromptConsumedAt: sandbox.initialTask.consumedAt ?? null,
          failureCode: sandbox.failureCode,
          failureReason: sandbox.failureReason,
          failureOperation: sandbox.failureOperation,
          automationFinishedAt: sandbox.automationFinishedAt,
          version,
          updatedAt,
        },
      })
      .run();

    if (result.changes !== 1) throw new SandboxWriteConflictError();
    for (const [offset, t] of sandbox.pendingTransitions.entries()) {
      db.insert(sandboxStateTransitions)
        .values({
          id: `${sandbox.id}-transition-${history.length - sandbox.pendingTransitions.length + offset}`,
          sandboxId: sandbox.id as string,
          fromStatus: t.from,
          toStatus: t.to,
          at: t.at,
          triggeredBy: t.triggeredBy,
        })
        .run();
    }

    sandbox.markPersisted(version);
  }

  private toDomain(row: SandboxRow, transitions: SandboxTransitionRow[]): Sandbox {
    return Sandbox.rehydrate({
      id: row.id as SandboxId,
      projectId: row.projectId as ProjectId,
      runtime: row.runtime,
      imageRef: row.imageRef ?? '',
      provider: row.provider,
      name: row.name ?? '',
      status: row.status as SandboxStatus,
      headless: row.headless,
      timeoutMinutes: row.timeoutMinutes,
      idleTimeoutSec: row.idleTimeoutSec,
      workspacePath: row.workspacePath,
      providerSandboxId: row.providerHandle,
      providerState: decodeProviderState(row.providerState),
      injectedRuntimes: decodeInjectedRuntimes(row.injectedRuntimes, row.runtime),
      initialTask: InitialTask.create({
        prompt: row.initialPrompt,
        consumedAt: row.initialPromptConsumedAt,
      }),
      failureCode: row.failureCode,
      failureReason: row.failureReason,
      failureOperation: row.failureOperation as Sandbox['failureOperation'],
      sourceAutomationId: row.sourceAutomationId,
      sourceAutomationName: row.sourceAutomationName,
      artifactRetentionDays: row.artifactRetentionDays as 3 | 7 | 30 | null,
      automationFinishedAt: row.automationFinishedAt,
      version: row.version,
      transitions: transitions.map((t) => ({
        from: t.fromStatus as SandboxStatus | null,
        to: t.toStatus as SandboxStatus,
        at: t.at,
        triggeredBy: t.triggeredBy as TriggeredBy,
      })),
    });
  }
}

/**
 * `providerState` ↔ 一列 JSON 文本。
 *
 * ⚠️ 平台**不认识里面任何一个键**（见 `SandboxHandle.providerState`）：这里只负责
 * 「对象 ⇄ 文本」，不校验形状、不填默认值——那样做等于替 provider 定义它的私有状态。
 */
/**
 * `injectedRuntimes` ↔ 一列 JSON 文本（03 §4.3 ④）。
 *
 * ⚠️ **NULL 与 `'[]'` 不是一回事，这就是这两个函数存在的全部理由**：
 *   · NULL  = 本切片**之前**建的旧行。那时 provision 只注入 `sandbox.runtime` 那一个
 *     —— 回落成 `[runtime]` 不是编造，是把当时的事实如实补上；
 *   · `'[]'` = 真的一个凭证都没注入（一个都没配）。
 * 合成一个值，「旧沙箱」就会与「裸跑的沙箱」长得一模一样，而前者能开一个 CLI 标签、
 * 后者一个都开不了。
 *
 * 解析失败同样回落成 `[runtime]` 并**不抛**：一列坏 JSON 不该让整个沙箱读不出来。
 */
function encodeInjectedRuntimes(ids: readonly string[]): string {
  return JSON.stringify([...ids]);
}

function decodeInjectedRuntimes(raw: string | null, fallbackRuntime: string): string[] {
  if (raw === null) return [fallbackRuntime];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [fallbackRuntime];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [fallbackRuntime];
  }
}

function encodeProviderState(state: Record<string, unknown> | null): string | null {
  return state === null ? null : JSON.stringify(state);
}

/**
 * ⚠️ **坏 JSON 降级成 `null`，不抛。**
 *
 * `null` 在这里是**诚实**的：provider 会发现自己没有状态可用，于是报「接不回这个实例」
 * ——那是一句准确的话。反过来，为一行坏数据抛异常会让**整个沙箱读不出来**，用户
 * 连删除它都做不到；而拿半个解析结果去连，则是拿一个编造的状态去够真实实例
 * （与 `decodeJobHandle` 返回空 handle 是同一条纪律）。
 */
function decodeProviderState(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through — 见上面的注释：null 比半个状态诚实 */
  }
  return null;
}
