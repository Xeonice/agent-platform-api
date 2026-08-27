import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

/**
 * 0013 —— `sandboxes` 的两列 provider 私有字段收成一列不透明 JSON（04 §2.2 / 13 §2.1）。
 *
 *   agent_endpoint_port (integer) ┐
 *   agent_auth_token    (text)    ┴─→ provider_state (text, JSON)
 *
 * ── 为什么这条迁移**必须**有自己的用例 ────────────────────────────────────────
 * drizzle-kit 生成的版本只有 `ADD COLUMN` + 两条 `DROP COLUMN`——它不知道旧的两列与新列的
 * 语义关系，所以**不会搬数据**。中间那条 `UPDATE` 是手工补的。而 `DROP COLUMN` 不可逆：
 * 漏掉 UPDATE 的话，所有存量沙箱在升级后**丢掉 agent 凭证**，表现是「重启后连不上自己的
 * 沙箱」，且无法从运行时反推（容器只持有公钥那一半）。
 *
 * ⚠️ 这类丢失**不会让任何现有测试变红**——新库跑完全部迁移得到的是一张空表，两列本来
 * 就没有值可丢。只有「先有存量数据、再升级」这条路能抓到它，那就是本文件。
 */
const DRIZZLE = resolve(process.cwd(), 'drizzle');
const FILES = readdirSync(DRIZZLE)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const THIS_MIGRATION = '0013_clumsy_maria_hill.sql';

function apply(db: Database.Database, file: string): void {
  const text = readFileSync(resolve(DRIZZLE, file), 'utf8');
  db.exec('BEGIN');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const q = stmt.trim();
    if (q) db.exec(q);
  }
  db.exec('COMMIT');
}

/** 升级前的库：跑完 0013 之前的全部迁移。 */
function preUpgradeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  for (const f of FILES.filter((f) => f < THIS_MIGRATION)) apply(db, f);
  db.pragma('foreign_keys = ON');
  return db;
}

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.fake-agent-jwt';

/**
 * 三种存量形态，缺一不可：
 *   ① 两列都有值（boxlite：转发端口 + 凭证）
 *   ② 只有凭证（aio：端口每次从 docker inspect 重解，不落库）
 *   ③ 两列都没有（切片前 / 无 agent 的裸镜像）
 * 少了 ②③ 就只测了"能搬"，测不出"该省的键有没有省、该留的 NULL 有没有留"。
 */
function seedPreUpgrade(db: Database.Database): void {
  db.prepare(
    "INSERT INTO projects (id, name, source_type, baseline_path, created_at, updated_at) VALUES ('p1','P','empty','/tmp/p1',1,1)",
  ).run();
  const ins = db.prepare(
    `INSERT INTO sandboxes (id, project_id, name, runtime, provider, status, headless,
       idle_timeout_sec, agent_endpoint_port, agent_auth_token, version, created_at, updated_at)
     VALUES (?, 'p1', ?, 'codex', ?, 'running', 0, 1800, ?, ?, 0, 1, 1)`,
  );
  ins.run('sb-both', 'both', 'boxlite', 54321, TOKEN);
  ins.run('sb-token-only', 'token only', 'aio', null, TOKEN);
  ins.run('sb-neither', 'neither', 'aio', null, null);
}

function upgraded(): Database.Database {
  const db = preUpgradeDb();
  seedPreUpgrade(db);
  db.pragma('foreign_keys = OFF');
  apply(db, THIS_MIGRATION);
  db.pragma('foreign_keys = ON');
  return db;
}

function stateOf(db: Database.Database, id: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT provider_state FROM sandboxes WHERE id = ?').get(id) as {
    provider_state: string | null;
  };
  return row.provider_state === null
    ? null
    : (JSON.parse(row.provider_state) as Record<string, unknown>);
}

describe('0013 folds the two agent columns into one opaque provider_state', () => {
  it('⭐ 存量凭证被搬进新列 —— 漏掉 UPDATE 就是跨升级丢数据面', () => {
    // MUTATION: 删掉迁移里那条 `UPDATE sandboxes SET provider_state = …` ⇒ 本条红。
    expect(stateOf(upgraded(), 'sb-both')).toEqual({
      agentEndpointPort: 54321,
      agentAuthToken: TOKEN,
    });
  });

  it('只有一列有值 ⇒ 另一个键**不出现**，而不是写成 null', () => {
    // ⚠️ `{"agentAuthToken":null}` 与「没有这个键」读回来同义，但前者看起来像
    //    "有这么个东西、值是空"，排查时多一次误导（与 `agentProviderState()` 同源）。
    const s = stateOf(upgraded(), 'sb-token-only');
    expect(s).toEqual({ agentAuthToken: TOKEN });
    expect(s).not.toHaveProperty('agentEndpointPort');
  });

  it('两列都没有 ⇒ 保持 NULL，不写成空对象', () => {
    // 空对象会让「这个 provider 没有状态」和「有状态但是空的」变成同一个东西。
    expect(stateOf(upgraded(), 'sb-neither')).toBeNull();
  });

  it('旧列真的没了（不是留着不用）', () => {
    const cols = (upgraded().pragma('table_info(sandboxes)') as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('provider_state');
    expect(cols).not.toContain('agent_endpoint_port');
    expect(cols).not.toContain('agent_auth_token');
  });

  it('⭐ 迁移文本里必须有搬数据那一步，且顺序在 DROP 之前', () => {
    // ⚠️ 这条断言的是**文本**，因为要防的是「有人重新跑 drizzle-kit generate 覆盖掉它」——
    //    工具生成的版本只有 ADD + DROP，跑起来一样"成功"，只是悄悄丢了所有凭证。
    //    上一条用例能抓到丢数据，这一条抓的是**顺序**：先 DROP 再 UPDATE 也会全绿地丢掉。
    const sql = readFileSync(resolve(DRIZZLE, THIS_MIGRATION), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    const update = sql.indexOf('UPDATE `sandboxes`');
    const drop = sql.indexOf('DROP COLUMN');
    expect(update).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(-1);
    expect(update).toBeLessThan(drop);
  });

  it('不重建表：`sandboxes` 被两张表 CASCADE 引用着', () => {
    const sql = readFileSync(resolve(DRIZZLE, THIS_MIGRATION), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/__new_/);
    expect(upgraded().pragma('foreign_key_check')).toEqual([]);
  });
});
