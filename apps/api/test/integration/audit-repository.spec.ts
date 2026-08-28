import { resolve } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Clock } from '@platform/shared-kernel';
import { AuditRepository, PRUNE_BATCH_SIZE } from '../../src/platform/audit/audit.repository';
import {
  AuditRetentionJob,
  RETENTION_DAYS,
  RETENTION_MAX_ROWS,
} from '../../src/platform/audit/audit-retention.job';

/**
 * `audit_events` 的 drizzle 往返（25 L2）—— **真 sqlite，真 migration**。
 *
 * 本文件盯的四件事，每一条都对着 13 §2.8.2 / 10 §6.6.1 的一句硬约定：
 *   · 双向游标的**方向**（`since` 向新、`before` 向老）
 *   · `hasMore` 的**断层**语义（多取一条判定，不是 count）
 *   · 保留裁剪的**分片边界**（每批 1000，且条数闸只裁到达标为止）
 *   · 响应**恒按 seq 降序**，与方向无关
 */

type Db = BetterSQLite3Database<Record<string, never>>;

let sqlite: Database.Database;
let db: Db;
let repo: AuditRepository;

/** 固定时钟。测试要能把「30 天前」摆在确定的位置上。 */
const NOW_MS = Date.parse('2026-08-27T12:00:00.000Z');
let nowMs = NOW_MS;
const clock: Clock = { now: () => new Date(nowMs) };

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  repo = new AuditRepository(db);
  nowMs = NOW_MS;
});

function seed(
  n: number,
  over: Partial<{ atMs: number; category: string; severity: string }> = {},
): void {
  const insert = sqlite.prepare(
    `INSERT INTO audit_events (at, category, type, severity, subject_type, subject_id, actor, summary)
     VALUES (?, ?, ?, ?, 'sandbox', ?, 'scheduler', ?)`,
  );
  const many = sqlite.transaction((count: number) => {
    for (let i = 0; i < count; i++) {
      insert.run(
        over.atMs ?? NOW_MS - (count - i) * 1000,
        over.category ?? 'sandbox',
        'sandbox.provision.stage',
        over.severity ?? 'info',
        `sbx-${String(i % 3)}`,
        `event ${String(i)}`,
      );
    }
  });
  many(n);
}

describe('audit_events —— migration 与列', () => {
  it('建了表与 13 §2.8.2 点名的三个索引', () => {
    const tables = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain('audit_events');

    const indexes = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_events'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_audit_events_subject',
        'idx_audit_events_category_seq',
        'idx_audit_events_at',
      ]),
    );
  });

  it('severity / outcome / category 三条 CHECK 是真的（越界值写不进去）', () => {
    const bad = (col: string, value: string): (() => void) => {
      const cols = 'at, category, type, severity, actor, summary, outcome';
      const row: Record<string, unknown> = {
        at: NOW_MS,
        category: 'sandbox',
        type: 't',
        severity: 'info',
        actor: 'system',
        summary: 's',
        outcome: null,
      };
      row[col] = value;
      return () =>
        sqlite
          .prepare(`INSERT INTO audit_events (${cols}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(cols.split(', ').map((c) => row[c]));
    };
    expect(bad('severity', 'critical')).toThrow(/CHECK/i);
    expect(bad('outcome', 'maybe')).toThrow(/CHECK/i);
    expect(bad('category', 'billing')).toThrow(/CHECK/i);
  });

  it('seq 是 AUTOINCREMENT —— 裁掉最新一批之后，新行不会复用旧号', () => {
    seed(3);
    sqlite.prepare('DELETE FROM audit_events').run();
    seed(1);
    const seqs = sqlite
      .prepare('SELECT seq FROM audit_events')
      .all()
      .map((r) => (r as { seq: number }).seq);
    // 没有 AUTOINCREMENT 时这里会回到 1 —— 而 1 是前端早就翻过去的位置。
    expect(seqs[0]).toBe(4);
  });
});

describe('双向游标（10 §6.6.1）', () => {
  it('since 只回更新的，before 只回更老的 —— 两个方向不能反', () => {
    seed(10); // seq 1..10
    const since = repo.list({ since: 7, limit: 100 });
    expect(since.items.map((i) => i.seq)).toEqual([10, 9, 8]);

    const before = repo.list({ before: 4, limit: 100 });
    expect(before.items.map((i) => i.seq)).toEqual([3, 2, 1]);
  });

  it('两个方向都恒按 seq 降序（UI 渲染顺序统一，前端不再排）', () => {
    seed(10);
    for (const criteria of [{ since: 0 }, { before: 11 }, {}]) {
      const { items } = repo.list({ ...criteria, limit: 100 });
      const seqs = items.map((i) => i.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    }
  });

  it('since 拉满 limit ⇒ hasMore=true，且返回的是**最新的**那一页（断层在下方）', () => {
    seed(10);
    const page = repo.list({ since: 0, limit: 3 });
    // ⚠️ 不是 [1,2,3]：`since` 要的是「比 since 新的那些里最新的 n 条」，
    // 取最旧的 n 条会让增量刷新永远追不上风暴的头部。
    expect(page.items.map((i) => i.seq)).toEqual([10, 9, 8]);
    expect(page.hasMore).toBe(true);
  });

  it('hasMore=false 只在真的取完时出现（limit 恰好等于剩余条数）', () => {
    seed(3);
    expect(repo.list({ limit: 3 }).hasMore).toBe(false);
    expect(repo.list({ limit: 2 }).hasMore).toBe(true);
  });

  it('from/to 与游标正交：同时给，两个条件都生效', () => {
    seed(10); // at = NOW-10s .. NOW-1s
    const from = new Date(NOW_MS - 5000);
    const both = repo.list({ before: 9, from, limit: 100 });
    // before=9 砍掉 9、10；from 砍掉 at < NOW-5s 的 seq 1..5
    expect(both.items.map((i) => i.seq)).toEqual([8, 7, 6]);
  });

  it('category / subjectId 筛选生效', () => {
    seed(6);
    expect(
      repo.list({ subjectId: 'sbx-1', limit: 100 }).items.every((i) => i.subjectId === 'sbx-1'),
    ).toBe(true);
    expect(repo.list({ category: 'project', limit: 100 }).items).toHaveLength(0);
  });
});

/**
 * `severity` **多值**（10 §6.6.1）—— 「仅告警」= `warn ∪ error`，在**服务端** `IN (...)`。
 *
 * ⚠️ 这一组的第一条就是这次改动存在的全部理由，值得把场景写清楚：等值过滤时前端只能
 * 不带 severity 拉一页（「最近 200 条」）再在客户端裁。平台平稳跑了一周、最近 200 条
 * 全是 info，昨天那次 provision 失败落在更老的位置 ⇒ 用户勾「仅告警」得到空列表 +
 * `hasMore:false`，读出来的结论是**「平台从没告警过」**。服务端过滤之后，`LIMIT` 取的
 * 是**匹配行**的最新一页，空结果才真的等于「全表没有告警」。
 */
describe('severity 多值过滤（10 §6.6.1「仅告警」）', () => {
  it('告警在第 201 条也拿得到 —— 过滤发生在 LIMIT 之前，不是客户端裁剪', () => {
    seed(1, { severity: 'error', atMs: NOW_MS - 500_000 }); // seq 1：最老的一条告警
    seed(200); // seq 2..201：一周的 info

    const alerts = repo.list({ severity: ['warn', 'error'], limit: 200 });
    expect(alerts.items.map((i) => i.seq)).toEqual([1]);
    // ⚠️ `hasMore:false` 在这里才有意义：它现在真的表示「没有更老的告警了」。
    expect(alerts.hasMore).toBe(false);

    // 对照组 —— 前端此前拿到的那一页里，这条告警**根本不在**。这一行说明客户端裁剪
    // 为什么救不回来：要裁的东西压根没被取回来。
    const clientSide = repo.list({ limit: 200 });
    expect(clientSide.items.some((i) => i.severity !== 'info')).toBe(false);
  });

  it('多值是并集，不是「取第一个」', () => {
    seed(2, { severity: 'warn' });
    seed(2, { severity: 'error' });
    seed(3); // info

    const both = repo.list({ severity: ['warn', 'error'], limit: 100 });
    expect(both.items).toHaveLength(4);
    expect(new Set(both.items.map((i) => i.severity))).toEqual(new Set(['warn', 'error']));
  });

  it('单值与旧的等值过滤等价（向后兼容）', () => {
    seed(2, { severity: 'warn' });
    seed(3, { severity: 'error' });
    const onlyError = repo.list({ severity: ['error'], limit: 100 });
    expect(onlyError.items).toHaveLength(3);
    expect(onlyError.items.every((i) => i.severity === 'error')).toBe(true);
  });
});

describe('保留裁剪（13 §2.8.2 双闸）', () => {
  it('⛔ 批次常量就是 1000 —— 13 §2.8.2 实测 5 万条阻塞 244ms、1000 条 7ms', () => {
    expect(PRUNE_BATCH_SIZE).toBe(1000);
  });

  it('⛔ 批间**让出事件循环** —— 别的回调能在裁剪中途跑起来', async () => {
    seed(3000, { atMs: NOW_MS - 100 * 24 * 3600 * 1000 });
    let pruneDone = false;
    const prune = repo.pruneOlderThan(new Date(NOW_MS)).then(() => {
      pruneDone = true;
    });
    // 一个 macrotask 回调。裁剪**让出**了事件循环，它才可能在裁剪结束前跑到；
    // 删掉 `await setImmediate()` 之后整段裁剪会在同一个 tick 里跑完，
    // 这个回调只能在之后才轮到 —— 那正是「所有 HTTP 请求排队」的样子。
    const interleaved = await new Promise<boolean>((r) => setImmediate(() => r(!pruneDone)));
    await prune;
    expect(interleaved).toBe(true);
  });

  it('⛔ 每批恰好 1000 条 —— 分片边界是硬纪律', async () => {
    seed(2500, { atMs: NOW_MS - 100 * 24 * 3600 * 1000 });
    const batches: number[] = [];
    const deleted = await repo.pruneOlderThan(new Date(NOW_MS), (n) => batches.push(n));
    expect(deleted).toBe(2500);
    // 2500 条 ⇒ 1000 / 1000 / 500。一次删完（[2500]）会阻塞事件循环 ~15ms 起步,
    // 5 万条实测 244ms —— 这条断言就是那条纪律。
    expect(batches).toEqual([PRUNE_BATCH_SIZE, PRUNE_BATCH_SIZE, 500]);
  });

  it('时间闸只裁 cutoff 之前的，边界那条（at === cutoff）留着', async () => {
    const cutoffMs = NOW_MS - 1000;
    seed(1, { atMs: cutoffMs - 1 });
    seed(1, { atMs: cutoffMs });
    seed(1, { atMs: cutoffMs + 1 });
    const deleted = await repo.pruneOlderThan(new Date(cutoffMs));
    expect(deleted).toBe(1);
    expect(repo.count()).toBe(2);
  });

  it('条数闸裁到达标为止，不多删一条（超额 300 时不会删满 1000）', async () => {
    seed(1300);
    const batches: number[] = [];
    const deleted = await repo.pruneToMaxRows(1000, (n) => batches.push(n));
    expect(deleted).toBe(300);
    expect(batches).toEqual([300]);
    expect(repo.count()).toBe(1000);
    // 留下的必须是**最新的** 1000 条（从旧到新裁）。
    const oldest = repo.list({ limit: 1, before: 2 }).items;
    expect(oldest).toHaveLength(0);
  });

  it('条数闸超额超过一批时同样分片', async () => {
    seed(2400);
    const batches: number[] = [];
    await repo.pruneToMaxRows(1000, (n) => batches.push(n));
    expect(batches).toEqual([PRUNE_BATCH_SIZE, 400]);
    expect(repo.count()).toBe(1000);
  });

  it('AuditRetentionJob 两个闸都跑（30 天 + 20 万条），且默认值就是文档那两个数', async () => {
    expect(RETENTION_DAYS).toBe(30);
    expect(RETENTION_MAX_ROWS).toBe(200_000);

    seed(5, { atMs: NOW_MS - 31 * 24 * 3600 * 1000 });
    seed(5, { atMs: NOW_MS - 1000 });
    const job = new AuditRetentionJob(repo, clock);
    const result = await job.sweep();
    expect(result).toEqual({ byAge: 5, byCount: 0 });
    expect(repo.count()).toBe(5);
  });
});
