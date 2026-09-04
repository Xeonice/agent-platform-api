import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { asAutomationId, asProjectId } from '@platform/shared-kernel';
// 相对路径而不是 `@platform/project/src/...`：包的 `exports` 只开了根出口，深路径在
// vitest 的解析器下走不通（这条是实测踩出来的）。测试跨包读内部文件是被允许的
// （eslint 对 test 关掉了 boundaries），但仍要走真实存在的路径。
import { Project } from '../../../project/src/domain/entities/project.entity';
import { SqliteProjectRepository } from '../../../project/src/infrastructure/persistence/sqlite/project.repository.impl';
import { Automation } from '../../src/domain/entities/automation.entity';
import { AutomationRun } from '../../src/domain/entities/automation-run.entity';
import { SqliteAutomationRepository } from '../../src/infrastructure/persistence/sqlite/automation.repository.impl';
import { SqliteAutomationRunRepository } from '../../src/infrastructure/persistence/sqlite/automation-run.repository.impl';
import { SqliteUnitOfWork } from '../../../../../apps/api/src/platform/persistence/unit-of-work.impl';

/**
 * `automations` / `automation_runs` 在**真 sqlite + 已提交的 migration** 上的往返（25 L1）。
 *
 * ── 每组断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① `saveSync` 的 `onConflictDoUpdate` 漏掉 `nextTriggerAt`/`degraded` ⇒ 往返那条红
 *  ② `listDue` 少了 `enabled = true`                       ⇒「禁用的规则扫不到」红
 *  ③ `listDue` 少了 `next_trigger_at <= now`               ⇒「未来的规则扫不到」红
 *  ④ `listOutcomePending` 少了 `outcome_applied = false`   ⇒ 补扫那条红
 *  ⑤ FK `ON DELETE CASCADE` 改成 no action                 ⇒「删规则连带删历史」红
 *  ⑥ CHECK `retry_count BETWEEN 0 AND 5` 去掉              ⇒ DB 侧 I-AUR-2 红
 *  ⑦ CHECK `log_bytes <= 31457280` 去掉                    ⇒ DB 侧 I-AUR-4 红
 *  ⑧ `automations.project_id` 的 FK RESTRICT 去掉          ⇒「删项目被 RESTRICT 挡住」红
 */
const at = (s: string) => new Date(s);
const T0 = at('2026-05-31T23:00:00Z');

function makeHarness() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite) as BetterSQLite3Database<Record<string, never>>;
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  const rules = new SqliteAutomationRepository(db);
  const runs = new SqliteAutomationRunRepository(db);
  const projects = new SqliteProjectRepository(db);
  const uow = new SqliteUnitOfWork(sqlite);
  // FK: automations.project_id → projects.id（RESTRICT）
  const project = Project.create({
    id: asProjectId('prj-aut'),
    name: 'automation-project',
    sourceType: 'empty',
    baselinePath: '/data/baselines/prj-aut',
    now: T0,
  });
  uow.run((tx) => projects.saveSync(tx, project));
  return { sqlite, db, rules, runs, uow, project };
}

function rule(id: string, overrides: Partial<Parameters<typeof Automation.create>[0]> = {}) {
  return Automation.create({
    id: asAutomationId(id),
    projectId: asProjectId('prj-aut'),
    name: `rule-${id}`,
    description: 'nightly regression',
    runtimeId: 'codex',
    prompt: 'run the checks',
    scheduleKind: 'weekly',
    scheduleConfig: { days: [1, 4], time: '08:00' },
    timezone: 'Asia/Shanghai',
    timeoutMinutes: 240,
    artifactRetentionDays: 30,
    webhookUrl: 'https://example.com/hook',
    triggerOn: 'all',
    now: T0,
    ...overrides,
  });
}

describe('SqliteAutomationRepository（真 sqlite + 真 migration）', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('saveSync 往返：21 列都读得回来，json 的 scheduleConfig 与时区快照原样', async () => {
    const a = rule('aut-1');
    h.uow.run((tx) => h.rules.saveSync(tx, a));

    const loaded = await h.rules.findById(asAutomationId('aut-1'));
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe('rule-aut-1');
    expect(loaded?.description).toBe('nightly regression');
    expect(loaded?.runtimeId).toBe('codex');
    expect(loaded?.prompt).toBe('run the checks');
    expect(loaded?.schedule.kind).toBe('weekly');
    expect(loaded?.schedule.config).toEqual({ days: [1, 4], time: '08:00' });
    // ★ 时区快照原样读回 —— 它是独立列，不在 json 里
    expect(loaded?.schedule.timezone).toBe('Asia/Shanghai');
    expect(loaded?.timeoutMinutes).toBe(240);
    expect(loaded?.retentionDays).toBe(30);
    expect(loaded?.webhook?.url).toBe('https://example.com/hook');
    expect(loaded?.webhook?.triggerOn).toBe('all');
    expect(loaded?.enabled).toBe(true);
    expect(loaded?.degraded).toBe(false);
    expect(loaded?.nextTriggerAt?.toISOString()).toBe(a.nextTriggerAt?.toISOString());
  });

  it('upsert：降频 + 失败计数 + nextTriggerAt 的变化都写得回去', async () => {
    const a = rule('aut-1');
    h.uow.run((tx) => h.rules.saveSync(tx, a));
    for (let i = 0; i < 3; i += 1) a.recordOutcome('failed', at('2026-06-01T01:00:00Z'));
    h.uow.run((tx) => h.rules.saveSync(tx, a));

    const loaded = await h.rules.findById(asAutomationId('aut-1'));
    expect(loaded?.failureCount).toBe(3);
    expect(loaded?.degraded).toBe(true);
    expect(loaded?.nextTriggerAt?.toISOString()).toBe(a.nextTriggerAt?.toISOString());
  });

  it('★ listDue：只捞 enabled=true **且** next_trigger_at <= now', async () => {
    const due = rule('due');
    const future = rule('future');
    const disabled = rule('disabled');
    disabled.disable(T0);
    h.uow.run((tx) => {
      h.rules.saveSync(tx, due);
      h.rules.saveSync(tx, future);
      h.rules.saveSync(tx, disabled);
    });

    // due 的 nextTriggerAt 是 2026-06-01T00:00Z（当地周一 08:00）
    const found = await h.rules.listDue(at('2026-06-01T00:00:00Z'));
    expect(found.map((r) => r.id).sort()).toEqual(['due', 'future']);

    // 往前一分钟：谁都不到期
    expect(await h.rules.listDue(at('2026-05-31T23:59:00Z'))).toHaveLength(0);
    // 禁用的那条即便时间到了也扫不到（它的 next_trigger_at 已被置 NULL）
    expect((await h.rules.listDue(at('2026-06-02T00:00:00Z'))).map((r) => r.id)).not.toContain(
      'disabled',
    );

    // ★ 更硬的一刀：直接把库里那一行的 `enabled` 关掉、**但保留 next_trigger_at**。
    // `disable()` 会顺手把时刻置 NULL，所以只靠聚合走不到这个局面 —— 而它恰恰是
    // `enabled = true` 这个条件唯一能证明自己有用的地方（历史行、或别处直接写的行）。
    h.sqlite.prepare('UPDATE automations SET enabled = 0 WHERE id = ?').run('due');
    expect((await h.rules.listDue(at('2026-06-01T00:00:00Z'))).map((r) => r.id)).toEqual([
      'future',
    ]);
  });

  it('countByProject 支撑 I-AUT-7 的应用层那一半', async () => {
    for (let i = 0; i < 3; i += 1) {
      const a = rule(`aut-${String(i)}`);
      h.uow.run((tx) => h.rules.saveSync(tx, a));
    }
    expect(await h.rules.countByProject(asProjectId('prj-aut'))).toBe(3);
    expect(await h.rules.countByProject(asProjectId('prj-other'))).toBe(0);
  });

  it('★ DB 侧 I-AUT-5：timeout / retention / prompt 长度的 CHECK 真的在库里', () => {
    const a = rule('aut-1');
    h.uow.run((tx) => h.rules.saveSync(tx, a));
    // 绕过聚合直接写库 —— 这正是 CHECK 存在的意义（双保险，23 §4.6）
    expect(() =>
      h.sqlite.prepare('UPDATE automations SET timeout_minutes = 45 WHERE id = ?').run('aut-1'),
    ).toThrow(/CHECK/i);
    expect(() =>
      h.sqlite
        .prepare('UPDATE automations SET artifact_retention_days = 14 WHERE id = ?')
        .run('aut-1'),
    ).toThrow(/CHECK/i);
    expect(() =>
      h.sqlite.prepare('UPDATE automations SET timezone = ? WHERE id = ?').run('', 'aut-1'),
    ).toThrow(/CHECK/i);
  });

  it('★ automations.project_id 是 FK RESTRICT：有规则时删项目会被挡住', () => {
    h.uow.run((tx) => h.rules.saveSync(tx, rule('aut-1')));
    expect(() => h.sqlite.prepare('DELETE FROM projects WHERE id = ?').run('prj-aut')).toThrow(
      /FOREIGN KEY/i,
    );
  });

  /**
   * ⭐⭐ **一行坏数据不许拖垮整批**（2026-08-31，code review 后补）。
   *
   * `toDomain` 每行都跑完整值对象校验（`Schedule.create` 真解 IANA、`normalizeConfig`、
   * `TimeoutPolicy.of`、`assertRetentionDays`、`WebhookTarget.create`）。上一版是裸
   * `.map(toDomain)` ⇒ **任何一行抛，整个 `listDue` 的结果全没**，而 `fireDue` 的
   * per-rule try/catch 在下游救不了、调度器的阶段隔离（H2）也只保证别的阶段照跑 ——
   * 这一轮仍然一条规则都不触发，日志上只有一行「automation sweep failed at stage
   * 'fire-due'」。
   *
   * ⇒ 症状是「**全部规则再也不触发**，每分钟一行日志」。真实触发路径不止一种：
   * tzdata/ICU 变更让某个曾经合法的 IANA 名解不出来（DB 侧 CHECK 只有
   * `length(timezone) > 0`）；或 `schedule_config` 这个**零 CHECK 的 JSON TEXT** 被
   * 迁移/手工改数据写进不合法组合。
   *
   * 这里直接用 SQL 绕过聚合写一行坏数据 —— 正是那两条路径的形状。
   */
  it('⭐⭐ listDue：一行坏数据被跳过，其余规则照常返回（不是整批失败）', async () => {
    const good = rule('aut-good');
    good.advanceTrigger(T0);
    h.uow.run((tx) => {
      h.rules.saveSync(tx, good);
    });
    // 坏行：timezone 是一个解不出来的 IANA 名（DB 的 CHECK 只管非空，拦不住）
    h.sqlite
      .prepare(
        `INSERT INTO automations (id, project_id, name, runtime_id, prompt, schedule_kind,
           schedule_config, timezone, timeout_minutes, artifact_retention_days, trigger_on,
           concurrency_mode, enabled, degraded, consecutive_failures, next_trigger_at,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'aut-broken',
        h.project.id,
        '坏行',
        'codex',
        'x',
        'daily',
        JSON.stringify({ time: '08:00' }),
        'Not/AZone',
        120,
        7,
        'failure',
        'skip',
        1,
        0,
        0,
        Math.floor(T0.getTime() / 1000),
        Math.floor(T0.getTime() / 1000),
        Math.floor(T0.getTime() / 1000),
      );

    const due = await h.rules.listDue(at('2026-06-01T02:00:00Z'));
    // ⛔ 上一版这里是 []（整批被那一行带走），好规则再也不会被触发
    expect(due.map((a) => a.id)).toEqual(['aut-good']);
  });
});

describe('SqliteAutomationRunRepository（真 sqlite + 真 migration）', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    h.uow.run((tx) => h.rules.saveSync(tx, rule('aut-1')));
  });

  const seedRun = (id: string, triggeredAt: Date): AutomationRun => {
    const r = AutomationRun.pending(id, asAutomationId('aut-1'), triggeredAt);
    h.uow.run((tx) => h.runs.saveSync(tx, r));
    return r;
  };

  it('saveSync 往返：17 列都读得回来（含 outcome_applied）', async () => {
    const run = seedRun('run-1', at('2026-06-01T00:00:00Z'));
    run.markRunning('sbx-1', at('2026-06-01T00:00:30Z'));
    run.attachLog('/data/logs/agent-tasks/t1/stdout.jsonl', 4096);
    run.finalize('timeout', at('2026-06-01T00:10:00Z'), {
      errorMessage: 'hard timeout',
      outputSummary: 'tail of stdout',
    });
    run.recordWebhookStatus('sent');
    h.uow.run((tx) => h.runs.saveSync(tx, run));

    const loaded = await h.runs.findById('run-1');
    expect(loaded?.status).toBe('timeout');
    expect(loaded?.sandboxId).toBe('sbx-1');
    expect(loaded?.durationSec).toBe(570);
    expect(loaded?.logPath).toBe('/data/logs/agent-tasks/t1/stdout.jsonl');
    expect(loaded?.logBytes).toBe(4096);
    expect(loaded?.outputSummary).toBe('tail of stdout');
    expect(loaded?.webhookStatus).toBe('sent');
    expect(loaded?.outcomeApplied).toBe(false);
  });

  it('findLatest 按 triggered_at 倒序 —— PREVIOUS_RUNNING 判定读的就是它', async () => {
    seedRun('run-old', at('2026-06-01T00:00:00Z'));
    seedRun('run-new', at('2026-06-01T01:00:00Z'));
    expect((await h.runs.findLatest(asAutomationId('aut-1')))?.id).toBe('run-new');
  });

  it('listByAutomation 游标：按 (triggered_at, id) 严格早于，hasMore 正确', async () => {
    for (let i = 0; i < 5; i += 1) {
      seedRun(`run-${String(i)}`, at(`2026-06-01T0${String(i)}:00:00Z`));
    }
    const p1 = await h.runs.listByAutomation(asAutomationId('aut-1'), { limit: 2 });
    expect(p1.items.map((r) => r.id)).toEqual(['run-4', 'run-3']);
    expect(p1.hasMore).toBe(true);

    const p2 = await h.runs.listByAutomation(asAutomationId('aut-1'), {
      before: 'run-3',
      limit: 2,
    });
    expect(p2.items.map((r) => r.id)).toEqual(['run-2', 'run-1']);
    expect(p2.hasMore).toBe(true);

    const p3 = await h.runs.listByAutomation(asAutomationId('aut-1'), {
      before: 'run-1',
      limit: 2,
    });
    expect(p3.items.map((r) => r.id)).toEqual(['run-0']);
    expect(p3.hasMore).toBe(false);
  });

  /**
   * ⭐⭐ 游标存在的全部理由：**翻页期间新落 run，下一页不许重复上一页的尾部**。
   *
   * offset 分页在这里必错：取完第 1 页（run-4/run-3）后新落一条 run-9，第 2 页
   * `offset=2` 会把 run-3 再吐一次 —— **而且看起来完全正常**（`useAuditStream`
   * 文件头纪律 ①，那段点名说的就是运行历史）。游标锚在 run-3 上，不受影响。
   */
  it('⭐⭐ 翻页期间头部新落 run ⇒ 下一页不重复（offset 会重复）', async () => {
    for (let i = 0; i < 5; i += 1) {
      seedRun(`run-${String(i)}`, at(`2026-06-01T0${String(i)}:00:00Z`));
    }
    const p1 = await h.runs.listByAutomation(asAutomationId('aut-1'), { limit: 2 });
    expect(p1.items.map((r) => r.id)).toEqual(['run-4', 'run-3']);

    // 用户还在看第 1 页时，调度器又落了一条（头部追加）
    seedRun('run-9', at('2026-06-01T09:00:00Z'));

    const p2 = await h.runs.listByAutomation(asAutomationId('aut-1'), {
      before: 'run-3',
      limit: 2,
    });
    expect(p2.items.map((r) => r.id)).toEqual(['run-2', 'run-1']);
    // ⛔ 关键：run-3 绝不能再出现一次
    expect(p2.items.map((r) => r.id)).not.toContain('run-3');
  });

  it('listPendingRetries：只捞 resource-exhausted 且 retry_at 已到', async () => {
    const queued = seedRun('run-q', at('2026-06-01T00:00:00Z'));
    queued.queueRetry(at('2026-06-01T00:00:00Z')); // retryAt = 00:24
    h.uow.run((tx) => h.runs.saveSync(tx, queued));
    seedRun('run-p', at('2026-06-01T00:00:00Z')); // 还是 pending，不该被捞

    expect(await h.runs.listPendingRetries(at('2026-06-01T00:23:00Z'))).toHaveLength(0);
    const due = await h.runs.listPendingRetries(at('2026-06-01T00:24:00Z'));
    expect(due.map((r) => r.id)).toEqual(['run-q']);
  });

  it('★ listActive：按状态直接捞 pending/running，**不受更新的终态 run 影响**', async () => {
    const running = seedRun('run-running', at('2026-06-01T00:00:00Z'));
    running.markRunning('sbx-1', at('2026-06-01T00:00:01Z'));
    h.uow.run((tx) => h.runs.saveSync(tx, running));
    // 更新的一条终态 run —— 曾经的 `findLatest` 取数会让上面那条被它盖住
    const skipped = AutomationRun.skipped(
      'run-skipped',
      asAutomationId('aut-1'),
      'PREVIOUS_RUNNING',
      'x',
      at('2026-06-01T01:00:00Z'),
    );
    h.uow.run((tx) => h.runs.saveSync(tx, skipped));
    const pending = seedRun('run-pending', at('2026-06-01T02:00:00Z'));
    void pending;

    const active = await h.runs.listActive();
    expect(active.map((r) => r.id).sort()).toEqual(['run-pending', 'run-running']);
  });

  it('★ listOutcomePending：只捞终态且 outcome_applied=false；skipped/missed 不在其中', async () => {
    const failed = seedRun('run-f', at('2026-06-01T00:00:00Z'));
    failed.markRunning('sbx-1', at('2026-06-01T00:00:01Z'));
    failed.finalize('failed', at('2026-06-01T00:05:00Z'));
    h.uow.run((tx) => h.runs.saveSync(tx, failed));

    const applied = seedRun('run-a', at('2026-06-01T01:00:00Z'));
    applied.markRunning('sbx-2', at('2026-06-01T01:00:01Z'));
    applied.finalize('success', at('2026-06-01T01:05:00Z'));
    applied.markOutcomeApplied();
    h.uow.run((tx) => h.runs.saveSync(tx, applied));

    const skipped = AutomationRun.skipped(
      'run-s',
      asAutomationId('aut-1'),
      'AUTH_EXPIRED',
      'no credential',
      at('2026-06-01T02:00:00Z'),
    );
    h.uow.run((tx) => h.runs.saveSync(tx, skipped));

    const pending = await h.runs.listOutcomePending(100);
    expect(pending.map((r) => r.id)).toEqual(['run-f']);
  });

  it('★ 删规则连带删历史（FK ON DELETE CASCADE）', async () => {
    seedRun('run-1', at('2026-06-01T00:00:00Z'));
    h.uow.run((tx) => h.rules.deleteSync(tx, asAutomationId('aut-1')));
    expect(await h.runs.findById('run-1')).toBeNull();
  });

  it('★ DB 侧 I-AUR-2 / I-AUR-4：retry_count 与 log_bytes 的 CHECK 真的在库里', () => {
    seedRun('run-1', at('2026-06-01T00:00:00Z'));
    expect(() =>
      h.sqlite.prepare('UPDATE automation_runs SET retry_count = 6 WHERE id = ?').run('run-1'),
    ).toThrow(/CHECK/i);
    expect(() =>
      h.sqlite.prepare('UPDATE automation_runs SET log_bytes = 31457281 WHERE id = ?').run('run-1'),
    ).toThrow(/CHECK/i);
    expect(() =>
      h.sqlite.prepare('UPDATE automation_runs SET status = ? WHERE id = ?').run('bogus', 'run-1'),
    ).toThrow(/CHECK/i);
  });
});
