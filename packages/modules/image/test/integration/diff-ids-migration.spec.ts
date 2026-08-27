import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

/**
 * 0011 —— 给 `image_manifests` 加血统锚点列 `diff_ids`（04 §7 ★血统 / 13 §2.4.2）。
 *
 * ── 为什么这条要真跑一遍升级，而不是只看新库建得出来 ────────────────────────────
 * 新库跑全部迁移必然是对的（`image-schema.spec.ts` 已经在测）。**升级**才是会出事的
 * 那一侧：`sandboxes.image_ref` 有一条 ON DELETE RESTRICT 的外键指着这张表，任何会
 * 重建它的写法都要在「FK 关掉」的窗口里 DROP 一张被引用的表。所以本文件测的是：
 *   ① 存量行还在，且新列按 `[]` 回填（不是 NULL，也不是编造的层）；
 *   ② 那条外键在升级之后**还指向 `image_manifests`**，且 `PRAGMA foreign_key_check` 干净；
 *   ③ 迁移文件本身是 `ADD COLUMN`——见下面那条为什么必须断言**文本**。
 *
 * ── 存量行为什么是 `[]` 而不是别的 ────────────────────────────────────────────
 * 切片前写下的行没有可复原的 `rootfs.diff_ids`。凭空编一个就是把
 * `'sha256:unresolved'` 换个地方放（I-IMG-6 就是为清掉那个占位符才立的）。`[]` 的语义
 * 是**「未知」**：`isDerivedFrom` 拒绝把空数组当锚点，因此这类行既不能给新镜像背书、
 * 也无法被证明是派生 —— fail-closed。
 */
const DRIZZLE = resolve(process.cwd(), 'drizzle');
const FILES = readdirSync(DRIZZLE)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const THIS_MIGRATION = '0011_stormy_tusk.sql';

/**
 * 迁移文件里**只有 DDL 的那部分**。
 *
 * ⚠️ 为什么必须剥注释：下面那条断言判的是「这个迁移有没有重建表」，而这些文件的注释里
 * 恰恰会**讨论**重建（写着 `__new_`、`DROP TABLE` 是怎么回事、为什么不这么干）。
 * 直接扫全文，等于「谁在注释里解释了这件事，谁就被判成做了这件事」——判据对不准它要拦的东西。
 * 实际踩过一次：给 0012 补完那段「为什么不重建」的说明，这条断言当场红了。
 */
function ddlOnly(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

function apply(db: Database.Database, file: string): void {
  const text = readFileSync(resolve(DRIZZLE, file), 'utf8');
  db.exec('BEGIN');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const q = stmt.trim();
    if (q) db.exec(q);
  }
  db.exec('COMMIT');
}

/** Everything BEFORE 0011 — a database as it stood after the image slice shipped. */
function preUpgradeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  for (const f of FILES.filter((f) => f < THIS_MIGRATION)) apply(db, f);
  db.pragma('foreign_keys = ON');
  return db;
}

function seedPreSlice(db: Database.Database): void {
  db.prepare(
    "INSERT INTO images (id, name, is_builtin, created_at) VALUES ('img-1','ghcr.io/x/y',1,1)",
  ).run();
  db.prepare(
    `INSERT INTO image_manifests
       (id, image_id, version, base_image, digest, entrypoint_contract, supported_runtimes,
        resource_defaults, labels_required, validation_status, is_active, registered_at)
     VALUES ('imf-1','img-1','latest','debian',?,'{}','[]','{}','[]','valid',1,1)`,
  ).run(`sha256:${'a'.repeat(64)}`);
  db.prepare(
    `INSERT INTO sandboxes (id, project_id, runtime, image_ref, headless, created_at, updated_at)
     VALUES ('sbx-1','prj-1','codex','imf-1',0,1,1)`,
  ).run();
}

describe('0011 adds diff_ids without touching the rows or the foreign key', () => {
  it('存量行保留，新列按 `[]` 回填（语义是「未知」，不是「没有层」）', () => {
    const db = preUpgradeDb();
    seedPreSlice(db);

    db.pragma('foreign_keys = OFF');
    apply(db, THIS_MIGRATION);
    db.pragma('foreign_keys = ON');

    expect(db.prepare('SELECT id, diff_ids FROM image_manifests').all()).toEqual([
      { id: 'imf-1', diff_ids: '[]' },
    ]);
    // ⚠️ NOT NULL EITHER. The column is `NOT NULL`, so a NULL here would mean the
    // migration ran but the constraint did not — and every read would then have to
    // defend against a value the type says cannot happen.
    expect(
      db.prepare('SELECT count(*) AS n FROM image_manifests WHERE diff_ids IS NULL').get(),
    ).toEqual({ n: 0 });
  });

  it('⭐ `sandboxes.image_ref` 的外键在升级后仍然指向 image_manifests，且无悬挂引用', () => {
    // ⚠️ 这条**抓不到**表重建——别把它当成那道闸。实测（SQLite 3.49，本轮亲手跑过）：
    // 把 0011 改写成 0010 那种「建新表-搬数据-改名」之后，下面三条断言**全绿**。原因是
    // SQLite 只在 RENAME 时改写指向**旧名字**的引用，而 `sandboxes` 引用的名字自始至终
    // 是 `image_manifests`：`__new_image_manifests` 改完名，那句 REFERENCES 原封不动。
    // 拦重建的闸在下一条用例（断言迁移**文本**），因为「FK 关闭的窗口里 DROP 一张被引用
    // 的表」这件事不会在升级完成后的库里留痕，只在迁移文件里看得见。
    //
    // 那么这条守的是什么：**数据和引用在升级中没被弄丢**——不管迁移怎么写，存量 sandbox
    // 还在、它指的 manifest 还在、RESTRICT 还活着。这是重建写错时（漏搬一行、漏建索引、
    // FK 没重建）真正会红的地方。
    const db = preUpgradeDb();
    seedPreSlice(db);
    db.pragma('foreign_keys = OFF');
    apply(db, THIS_MIGRATION);
    db.pragma('foreign_keys = ON');

    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='sandboxes'").get() as {
      sql: string;
    };
    expect(ddl.sql).toMatch(/REFERENCES `image_manifests`/);
    expect(ddl.sql).not.toMatch(/__new_/);
    expect(db.prepare('SELECT count(*) AS n FROM sandboxes').get()).toEqual({ n: 1 });
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // …and the RESTRICT is still live: deleting a manifest a sandbox points at fails.
    expect(() => db.prepare("DELETE FROM image_manifests WHERE id='imf-1'").run()).toThrow(
      /FOREIGN KEY/i,
    );
  });

  it('⭐ 这条迁移必须是 `ADD COLUMN`，不许重建一张**被引用**的表', () => {
    // ⚠️ 断言迁移**文本**不是偷懒，是因为运行期断言在这里守不住（理由见上一条）。
    // 0010 之所以重建，是 SQLite 不支持 `ADD CONSTRAINT`；加一个普通列没有这个限制，
    // 而重建一张被 REFERENCES 的表意味着在 FK 关闭的窗口里 DROP 它 —— 风险严格更大、
    // 收益为零。同形约束见 `derived-from-digest-migration.spec.ts`（0012）。
    const sqlText = ddlOnly(readFileSync(resolve(DRIZZLE, THIS_MIGRATION), 'utf8'));
    expect(sqlText).toMatch(/ALTER TABLE `image_manifests` ADD `diff_ids` text/);
    expect(sqlText).not.toMatch(/DROP TABLE/i);
    expect(sqlText).not.toMatch(/__new_/);
  });

  it('升级后写入的新行带得上真的层列表', () => {
    const db = preUpgradeDb();
    seedPreSlice(db);
    db.pragma('foreign_keys = OFF');
    apply(db, THIS_MIGRATION);
    db.pragma('foreign_keys = ON');

    db.prepare(
      `INSERT INTO image_manifests
         (id, image_id, version, base_image, digest, entrypoint_contract, supported_runtimes,
          resource_defaults, labels_required, diff_ids, validation_status, is_active, registered_at)
       VALUES ('imf-2','img-1','v2','debian',?,'{}','[]','{}','[]',?,'valid',1,2)`,
    ).run(`sha256:${'b'.repeat(64)}`, JSON.stringify(['sha256:l1', 'sha256:l2']));

    expect(db.prepare("SELECT diff_ids FROM image_manifests WHERE id='imf-2'").get()).toEqual({
      diff_ids: '["sha256:l1","sha256:l2"]',
    });
  });
});
