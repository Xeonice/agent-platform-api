import { Inject, Injectable } from '@nestjs/common';
import { eq, ne, and, inArray, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { SandboxId, ProjectId, Tx } from '@platform/shared-kernel';
import { Sandbox } from '../../../domain/entities/sandbox.entity';
import { InitialTask } from '../../../domain/value-objects/initial-task.vo';
import type { SandboxStatus } from '../../../domain/value-objects/sandbox-status.vo';
import type { TriggeredBy } from '../../../domain/entities/state-transition.entity';
import type { SandboxRepository } from '../../../domain/repositories/sandbox.repository';
import {
  sandboxes,
  sandboxStateTransitions,
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

  async findById(id: SandboxId): Promise<Sandbox | null> {
    const row = this.db.select().from(sandboxes).where(eq(sandboxes.id, id)).get();
    if (!row) return null;
    const transitions = this.db
      .select()
      .from(sandboxStateTransitions)
      .where(eq(sandboxStateTransitions.sandboxId, id))
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

    db.insert(sandboxes)
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
        initialPrompt: sandbox.initialTask.prompt ?? null,
        initialPromptConsumedAt: sandbox.initialTask.consumedAt ?? null,
        failureCode: sandbox.failureCode,
        failureReason: sandbox.failureReason,
        version: sandbox.version,
        createdAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: sandboxes.id,
        set: {
          name: sandbox.name,
          status: sandbox.status,
          timeoutMinutes: sandbox.timeoutMinutes,
          idleTimeoutSec: sandbox.idleTimeoutSec,
          providerHandle: sandbox.providerSandboxId,
          workspacePath: sandbox.workspacePath,
          providerState: encodeProviderState(sandbox.providerState),
          // the instruction itself never changes after T1; only its consumed marker
          // moves (once, forward) — see I-SBX-10.
          initialPromptConsumedAt: sandbox.initialTask.consumedAt ?? null,
          failureCode: sandbox.failureCode,
          failureReason: sandbox.failureReason,
          version: sandbox.version,
          updatedAt,
        },
      })
      .run();

    for (const t of sandbox.pendingTransitions) {
      db.insert(sandboxStateTransitions)
        .values({
          id: `${sandbox.id}-${t.to}-${t.at.getTime()}`,
          sandboxId: sandbox.id as string,
          fromStatus: t.from,
          toStatus: t.to,
          at: t.at,
          triggeredBy: t.triggeredBy,
        })
        .run();
    }

    // NOTE: optimistic-lock version bump is a full-slice TODO (28 §2.2). The
    // scaffold persists the aggregate's current version as-is.
    sandbox.markPersisted(sandbox.version);
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
      initialTask: InitialTask.create({
        prompt: row.initialPrompt,
        consumedAt: row.initialPromptConsumedAt,
      }),
      failureCode: row.failureCode,
      failureReason: row.failureReason,
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
