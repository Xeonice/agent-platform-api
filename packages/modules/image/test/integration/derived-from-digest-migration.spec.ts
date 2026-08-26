import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

/**
 * 0012 —— 给 `image_manifests` 加「基于哪一张」`derived_from_digest`（04 §7 ★血统）。
 *
 * ── 这一列在测什么，以及为什么值得单独一个升级用例 ────────────────────────────
 * 新库跑全部迁移必然是对的（`image-schema.spec.ts` 在测）。**升级**才是会出事的那一侧：
 * `sandboxes.image_ref` 有一条 ON DELETE RESTRICT 的外键指着这张表，任何会重建它的写法都要
 * 在「FK 关掉」的窗口里 DROP 一张被引用的表。0011 已经踩过这条线并把理由写在了迁移里；本文件
 * 把同一条线钉在 0012 上，因为「照着先例的**动作**抄」这件事每加一列都会重新有机会发生。
 *
 * ── 存量行为什么是 NULL，以及 NULL 的两种语义 ────────────────────────────────
 * 切片前写下的行 `diff_ids` 是 `[]`，祖先不可复原；凭空编一个就是 `'sha256:unresolved'` 换个
 * 马甲（I-IMG-6 就是为清掉那个占位符才立的）。所以 NULL = 「不知道」。而**预制根镜像**同样
 * 是 NULL，那里的 NULL = 「本来就没有平台祖先」。两者区分的事实在隔壁 `images.is_builtin`，
 * 不在这一列里——任何把 NULL 一律读成「未基于平台镜像」的读者都会同时冤枉两种行。
 *
 * ── ⭐ 这一列刻意没有外键 ─────────────────────────────────────────────────────
 * 13 §2.9 记着三条「两张表都在、FK 却没建」的欠账，读起来像约束、实际不是。**这一列不是第四
 * 条**：它必须在目标行被删除之后**继续有效**（血统是历史事实），那正好是 RESTRICT / CASCADE
 * 的反面。下面那条 ⭐ 用例就是这句话的可执行形式。
 */
const DRIZZLE = resolve(process.cwd(), 'drizzle');
const FILES = readdirSync(DRIZZLE)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const THIS_MIGRATION = '0012_wealthy_psynapse.sql';

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

/** Everything BEFORE 0012 — a database as it stood after the lineage CHECK shipped. */
function preUpgradeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  for (const f of FILES.filter((f) => f < THIS_MIGRATION)) apply(db, f);
  db.pragma('foreign_keys = ON');
  return db;
}

const ANCHOR_DIGEST = `sha256:${'a'.repeat(64)}`;
const DERIVED_DIGEST = `sha256:${'b'.repeat(64)}`;

/** One built-in anchor + one derived row + a sandbox holding the derived row. */
function seedPreUpgrade(db: Database.Database): void {
  db.prepare(
    "INSERT INTO images (id, name, is_builtin, created_at) VALUES ('img-base','ghcr.io/platform/base',1,1)",
  ).run();
  db.prepare(
    "INSERT INTO images (id, name, is_builtin, created_at) VALUES ('img-user','ghcr.io/user/app',0,1)",
  ).run();
  const insert = db.prepare(
    `INSERT INTO image_manifests
       (id, image_id, version, base_image, digest, entrypoint_contract, supported_runtimes,
        resource_defaults, labels_required, diff_ids, validation_status, is_active, registered_at)
     VALUES (?,?,?,'debian',?,'{}','[]','{}','[]',?,'valid',1,1)`,
  );
  insert.run('imf-base', 'img-base', 'v1', ANCHOR_DIGEST, JSON.stringify(['sha256:l1']));
  insert.run(
    'imf-user',
    'img-user',
    'v1',
    DERIVED_DIGEST,
    JSON.stringify(['sha256:l1', 'sha256:l2']),
  );
  db.prepare(
    `INSERT INTO sandboxes (id, project_id, runtime, image_ref, headless, created_at, updated_at)
     VALUES ('sbx-1','prj-1','codex','imf-user',0,1,1)`,
  ).run();
}

function upgraded(): Database.Database {
  const db = preUpgradeDb();
  seedPreUpgrade(db);
  db.pragma('foreign_keys = OFF');
  apply(db, THIS_MIGRATION);
  db.pragma('foreign_keys = ON');
  return db;
}

describe('0012 records WHICH anchor an image descends from', () => {
  it('存量行保留，新列为 NULL —— 祖先不可复原，也不准编造', () => {
    const db = upgraded();
    expect(
      db.prepare('SELECT id, derived_from_digest AS d FROM image_manifests ORDER BY id').all(),
    ).toEqual([
      { id: 'imf-base', d: null },
      { id: 'imf-user', d: null },
    ]);
    // ⚠️ 也不是空串。`''` 会让「有没有血统记录」这个判断从 `!== null` 悄悄退化成
    // 「truthy 检查」，而空串是 falsy —— 两种写法在这一列上碰巧同义，直到有人写了
    // `if (row.derivedFromDigest)` 去判断「是不是根镜像」为止。
    expect(
      db.prepare("SELECT count(*) AS n FROM image_manifests WHERE derived_from_digest = ''").get(),
    ).toEqual({ n: 0 });
  });

  it('⭐ 这条迁移必须是 `ADD COLUMN`，不许重建一张**被引用**的表', () => {
    // ⚠️ 这一条断言的是**迁移文本**，而那不是偷懒——是因为运行期断言在这里守不住。
    // 实测（SQLite 3.49）：把本迁移改写成 0010 那种「建新表-搬数据-改名」之后，
    // `sandboxes` 的 DDL **原封不动**（它引用的名字 `image_manifests` 没变，SQLite 只在
    // RENAME 时改写指向**旧名字**的引用），`PRAGMA foreign_key_check` 干净，RESTRICT
    // 也照样生效——于是「查 DDL 里还写不写着 image_manifests」这类运行期断言**全绿**。
    // 换句话说：真正要拦的那件事（在 FK 关闭的窗口里 DROP 一张被引用的表）不会在升级
    // 完成后的库里留下任何痕迹，只在**迁移文件本身**里看得见。
    //
    // ⚠️ `diff-ids-migration.spec.ts` 里那条同形用例的注释说「照 0010 抄就会红」——
    // 按上面的实测，那句话是**反的**，那条用例拦不住重建。见本轮结论。
    const sqlText = ddlOnly(readFileSync(resolve(DRIZZLE, THIS_MIGRATION), 'utf8'));
    expect(sqlText).toMatch(/ALTER TABLE `image_manifests` ADD `derived_from_digest` text;/);
    expect(sqlText).not.toMatch(/DROP TABLE/i);
    expect(sqlText).not.toMatch(/__new_/);
  });

  it('升级不动存量数据，也不动那条指着本表的外键', () => {
    const db = upgraded();
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='sandboxes'").get() as {
      sql: string;
    };
    expect(ddl.sql).toMatch(/REFERENCES `image_manifests`/);
    expect(db.prepare('SELECT count(*) AS n FROM sandboxes').get()).toEqual({ n: 1 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // RESTRICT 仍然活着：还被 Task 引用的镜像版本删不掉（13 §2.9 #2）。
    expect(() => db.prepare("DELETE FROM image_manifests WHERE id='imf-user'").run()).toThrow(
      /FOREIGN KEY/i,
    );
  });

  it('⭐ 这一列本身**没有**外键：删掉锚点行不被挡，派生行的血统记录也不被清掉', () => {
    // 三条理由的可执行形式（见迁移文件头）：血统是历史事实而不是活引用；digest 是内容
    // 寻址的，锚点行没了它照样指得准；所以这里的「没建 FK」是设计，不是欠账。
    // 换成 `REFERENCES image_manifests(id)`：要么 RESTRICT 让这次 DELETE 抛错，要么
    // CASCADE / SET NULL 把派生行的血统抹掉——两种都是这条用例要拦的。
    const db = upgraded();
    db.prepare("UPDATE image_manifests SET derived_from_digest = ? WHERE id='imf-user'").run(
      ANCHOR_DIGEST,
    );
    db.prepare("UPDATE sandboxes SET image_ref = NULL WHERE id='sbx-1'").run();

    expect(() => db.prepare("DELETE FROM image_manifests WHERE id='imf-base'").run()).not.toThrow();

    expect(
      db.prepare("SELECT derived_from_digest AS d FROM image_manifests WHERE id='imf-user'").get(),
    ).toEqual({ d: ANCHOR_DIGEST });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('升级后写入的新行带得上锚点 digest', () => {
    const db = upgraded();
    db.prepare(
      `INSERT INTO image_manifests
         (id, image_id, version, base_image, digest, entrypoint_contract, supported_runtimes,
          resource_defaults, labels_required, diff_ids, derived_from_digest, validation_status,
          is_active, registered_at)
       VALUES ('imf-new','img-user','v2','debian',?,'{}','[]','{}','[]','[]',?,'valid',1,2)`,
    ).run(`sha256:${'c'.repeat(64)}`, ANCHOR_DIGEST);

    expect(
      db.prepare("SELECT derived_from_digest AS d FROM image_manifests WHERE id='imf-new'").get(),
    ).toEqual({ d: ANCHOR_DIGEST });
  });
});
