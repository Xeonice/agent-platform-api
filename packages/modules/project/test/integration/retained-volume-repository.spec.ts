import { resolve } from 'node:path';
import { beforeEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { asProjectId, asRetainedVolumeId } from '@platform/shared-kernel';
import { RetainedVolume } from '../../src/domain/entities/retained-volume.entity';
import { SqliteRetainedVolumeRepository } from '../../src/infrastructure/persistence/sqlite/retained-volume.repository.impl';
import { SqliteProjectRepository } from '../../src/infrastructure/persistence/sqlite/project.repository.impl';
import { Project } from '../../src/domain/entities/project.entity';
import { SqliteUnitOfWork } from '../../../../../apps/api/src/platform/persistence/unit-of-work.impl';

/**
 * `retained_volumes` 在**真 sqlite + 已提交的 migration** 上的往返（25 L1）。
 *
 * ── 每组断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① migration 里的 `UNIQUE(workspace_path)` 去掉 ⇒「同一目录不能登记两次」红。
 *     这是 I-RV-3 唯一能挡住**并发**销毁的那一半，应用层的 `findByWorkspacePath` 挡不住。
 *  ② `listExpired` 里的 `deleted_at IS NULL` 去掉 ⇒「已清理的不再被 reaper 捞出来」红。
 *  ③ `listByProject` 的默认 `includeDeleted=false` 反过来 ⇒「列表不含已清理」红。
 *  ④ `saveSync` 的 `onConflictDoUpdate` 里漏掉 `deletedAt` ⇒「清理后能读回 deletedAt」红。
 *  ⑤ CHECK `retain_until > retained_at` 去掉 ⇒ 最后一条（DB 侧 I-RV-1）红。
 */
function makeHarness() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite) as BetterSQLite3Database<Record<string, never>>;
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  const repo = new SqliteRetainedVolumeRepository(db);
  const projects = new SqliteProjectRepository(db);
  const uow = new SqliteUnitOfWork(sqlite);
  const now = new Date('2026-08-31T00:00:00.000Z');
  // FK: retained_volumes.project_id → projects.id
  const project = Project.create({
    id: asProjectId('prj-rv'),
    name: 'rv-project',
    sourceType: 'empty',
    baselinePath: '/data/baselines/prj-rv',
    now,
  });
  uow.run((tx) => projects.saveSync(tx, project));
  return { sqlite, db, repo, uow, now };
}

const volume = (id: string, path: string, now: Date, days: 3 | 7 | 30 = 30) =>
  RetainedVolume.register({
    id: asRetainedVolumeId(id),
    projectId: asProjectId('prj-rv'),
    sandboxId: `sbx-${id}`,
    workspacePath: path,
    source: 'manual-destroy',
    retentionDays: days,
    diskBytes: 1_073_741_824,
    downloadBytes: 14_680_064,
    now,
  });

describe('SqliteRetainedVolumeRepository（真 sqlite + 真 migration）', () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    h = makeHarness();
  });

  it('saveSync 往返：九列都读得回来，两个大小分别存', async () => {
    const v = volume('rv-1', '/data/workspaces/sbx-1', h.now);
    h.uow.run((tx) => h.repo.saveSync(tx, v));

    const loaded = await h.repo.findById(asRetainedVolumeId('rv-1'));
    expect(loaded).not.toBeNull();
    expect(loaded?.projectId).toBe('prj-rv');
    expect(loaded?.sandboxId).toBe('sbx-rv-1');
    expect(loaded?.workspacePath).toBe('/data/workspaces/sbx-1');
    expect(loaded?.source).toBe('manual-destroy');
    // ★ 差 70 倍的两个数必须各存各的（13 §2.2.2）
    expect(loaded?.diskBytes).toBe(1_073_741_824);
    expect(loaded?.downloadBytes).toBe(14_680_064);
    expect(loaded?.retainedAt.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(loaded?.retainUntil.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(loaded?.deletedAt).toBeNull();
  });

  it('★ I-RV-3：同一个 workspace_path 登记两次被 DB 挡住（并发销毁唯一的那道防线）', () => {
    h.uow.run((tx) => h.repo.saveSync(tx, volume('rv-1', '/data/workspaces/sbx-1', h.now)));
    expect(() =>
      h.uow.run((tx) => h.repo.saveSync(tx, volume('rv-2', '/data/workspaces/sbx-1', h.now))),
    ).toThrow(/UNIQUE/i);
  });

  it('findByWorkspacePath 是应用层那一半：重放时先问「登记过没有」', async () => {
    h.uow.run((tx) => h.repo.saveSync(tx, volume('rv-1', '/data/workspaces/sbx-1', h.now)));
    expect((await h.repo.findByWorkspacePath('/data/workspaces/sbx-1'))?.id).toBe('rv-1');
    expect(await h.repo.findByWorkspacePath('/data/workspaces/never')).toBeNull();
  });

  it('★ 列表默认不含已清理的（I-RV-2 只读留档，对外等于不存在）', async () => {
    const live = volume('rv-live', '/data/workspaces/live', h.now);
    const gone = volume('rv-gone', '/data/workspaces/gone', h.now);
    gone.markDeleted(new Date('2026-09-01T00:00:00.000Z'));
    h.uow.run((tx) => {
      h.repo.saveSync(tx, live);
      h.repo.saveSync(tx, gone);
    });

    expect((await h.repo.listByProject(asProjectId('prj-rv'))).map((v) => v.id)).toEqual([
      'rv-live',
    ]);
    expect((await h.repo.listAll()).map((v) => v.id)).toEqual(['rv-live']);
    // 留档还在，只是不对外
    expect(
      (await h.repo.listByProject(asProjectId('prj-rv'), true)).map((v) => v.id).sort(),
    ).toEqual(['rv-gone', 'rv-live']);
    expect((await h.repo.findById(asRetainedVolumeId('rv-gone')))?.deletedAt?.toISOString()).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });

  it('★ listExpired 只捞到期**且未清理**的 —— 少了后半句 reaper 每轮都会重放全部历史', async () => {
    const short = volume('rv-short', '/data/workspaces/short', h.now, 3);
    const long = volume('rv-long', '/data/workspaces/long', h.now, 30);
    const already = volume('rv-already', '/data/workspaces/already', h.now, 3);
    already.markDeleted(new Date('2026-09-04T00:00:00.000Z'));
    h.uow.run((tx) => {
      h.repo.saveSync(tx, short);
      h.repo.saveSync(tx, long);
      h.repo.saveSync(tx, already);
    });

    const expired = await h.repo.listExpired(new Date('2026-09-05T00:00:00.000Z'));
    expect(expired.map((v) => v.id)).toEqual(['rv-short']);
  });

  it('★ DB 侧的 I-RV-1：CHECK 拦住 retain_until <= retained_at（双保险的另一半）', () => {
    const v = volume('rv-bad', '/data/workspaces/bad', h.now);
    // 直接改只读字段，模拟「应用层那道校验被绕过/写坏」——双保险要证明的正是这种情形
    Object.defineProperty(v, 'retainUntil', { value: new Date('2026-08-30T00:00:00.000Z') });
    expect(() => h.uow.run((tx) => h.repo.saveSync(tx, v))).toThrow(/CHECK/i);
  });

  it('project_id 的 FK 是真的：不存在的项目登不进来', () => {
    const orphan = RetainedVolume.register({
      id: asRetainedVolumeId('rv-orphan'),
      projectId: asProjectId('prj-does-not-exist'),
      workspacePath: '/data/workspaces/orphan',
      source: 'automation-artifact',
      retentionDays: 7,
      diskBytes: 1,
      downloadBytes: 1,
      now: h.now,
    });
    expect(() => h.uow.run((tx) => h.repo.saveSync(tx, orphan))).toThrow(/FOREIGN KEY/i);
  });
});
