import { resolve } from 'node:path';
import { beforeEach, describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { ImageManifest } from '../../src/domain/entities/image-manifest.entity';
import { Image } from '../../src/domain/entities/image.entity';
import { ValidationOutcome } from '../../src/domain/value-objects/validation-outcome.vo';
import { SqliteImageRepository } from '../../src/infrastructure/persistence/sqlite/image.repository.impl';
import { SqliteImageManifestRepository } from '../../src/infrastructure/persistence/sqlite/image-manifest.repository.impl';
import { SqliteUnitOfWork } from '../../../../../apps/api/src/platform/persistence/unit-of-work.impl';

/**
 * Real better-sqlite3 + Drizzle + the committed migrations. What this file guards is
 * the pair of constraints 13 §2.4.2 ★ leans on — one for IDENTITY, one for the CURRENT
 * POINTER — plus the cross-context RESTRICT that makes 「使用中的镜像不可硬删」 true.
 * None of them is expressible in the aggregate (23 §4.6 第三类), so if the DB does not
 * hold them, nothing does.
 */
const NOW = new Date('2026-08-25T00:00:00.000Z');
const digest = (seed: string): string => `sha256:${seed.repeat(64).slice(0, 64)}`;

function makeHarness() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite) as BetterSQLite3Database<Record<string, never>>;
  // Migrations rebuild `sandboxes` (FK), which needs enforcement OFF — exactly what
  // `runMigrations` does in production (drizzle.connection.ts).
  sqlite.pragma('foreign_keys = OFF');
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  sqlite.pragma('foreign_keys = ON');
  return {
    sqlite,
    db,
    images: new SqliteImageRepository(db),
    manifests: new SqliteImageManifestRepository(db),
    uow: new SqliteUnitOfWork(sqlite),
  };
}

function manifest(over: Partial<Parameters<typeof ImageManifest.create>[0]> = {}) {
  return ImageManifest.create(
    {
      id: 'imf-1',
      imageId: 'img-1',
      version: 'latest',
      baseImage: 'debian',
      digest: digest('a'),
      entrypointContract: { workdir: '/', entrypoint: ['/bin/sh'] },
      supportedRuntimes: ['codex'],
      resourceDefaults: { cores: 1, ramMb: 512, diskMb: 1024 },
      labelsRequired: ['platform.tmux'],
      diffIds: ['sha256:layer-1', 'sha256:layer-2'],
      derivedFromDigest: null,
      validation: ValidationOutcome.from([], []),
      config: null,
      isActive: true,
      registeredAt: NOW,
      ...over,
    },
    'localhost:5001/platform/sandbox:v2',
  );
}

let h: ReturnType<typeof makeHarness>;
beforeEach(() => {
  h = makeHarness();
  const image = Image.create({
    id: 'img-1',
    name: 'ghcr.io/agent-infra/sandbox',
    ownerRef: null,
    isBuiltin: false,
    createdAt: NOW,
  });
  h.uow.run((tx) => h.images.saveSync(tx, image));
});

/**
 * ⭐ 血统锚点必须**跨重启存活**（04 §7 ★血统 / 13 §2.4.2）。
 *
 * 每次注册都要拿新镜像的 `diff_ids` 去比对**库里已有的**预制镜像。如果这一列没真的
 * 落库，唯一的替代方案是每次去问 registry —— 那会把 `REGISTRY_UNREACHABLE`（本组唯一
 * 的 retryable 码）拖进一件纯本地的比对里，并让离线部署彻底注册不了镜像。
 */
describe('diff_ids 真的进了库，并且原样读得回来', () => {
  it('roundtrip：写进去的层列表，读回来一字不差、顺序不变', async () => {
    const layers = [`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`];
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest({ diffIds: layers })));
    // MUTATION: 把 `saveSync` 的 values 里那行 `diffIds: manifest.diffIds` 删掉 ⇒
    // 列取 DEFAULT '[]'，本条红。
    const back = await h.manifests.findById('imf-1');
    expect(back?.diffIds).toEqual(layers);
    // ⚠️ ORDER IS PART OF THE VALUE. 前缀比对按下标逐位比，一个把列表当集合存/读的
    // 实现（排序、去重）会让「中间层不同、末尾碰巧一样」的镜像通过血统校验。
    expect(back?.diffIds[0]).toBe(layers[0]);
  });

  it('⚠️ diff_ids 是身份的一部分：`onConflictDoUpdate` 不许改它（I-IMG-7）', async () => {
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest({ diffIds: ['sha256:original'] })));
    // 同一个 id 再存一次，带着**不同**的层列表——真实世界里这不该发生，但 `set` 列表
    // 是唯一决定「哪些字段可变」的地方，而它写错了不会有任何东西报错。
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest({ diffIds: ['sha256:tampered'] })));
    const back = await h.manifests.findById('imf-1');
    // MUTATION: 往 `set:` 里加一行 `diffIds` ⇒ 本条红。锚点可变 = 血统结论可以被
    // 事后改写，而库里所有基于它注册过的镜像不会重新判定。
    expect(back?.diffIds).toEqual(['sha256:original']);
  });

  it('listBuiltinAnchors 只取 builtin 镜像的行，并带出可照抄的 ref', async () => {
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest({ diffIds: ['sha256:user'] })));
    expect(await h.manifests.listBuiltinAnchors()).toEqual([]);

    h.uow.run((tx) =>
      h.images.saveSync(
        tx,
        Image.create({
          id: 'img-base',
          name: 'ghcr.io/platform/base',
          ownerRef: null,
          isBuiltin: true,
          createdAt: NOW,
        }),
      ),
    );
    h.uow.run((tx) =>
      h.manifests.saveSync(
        tx,
        manifest({
          id: 'imf-base',
          imageId: 'img-base',
          version: 'v1',
          digest: digest('d'),
          diffIds: ['sha256:root'],
        }),
      ),
    );

    // ⚠️ THE `ref` IS NOT DECORATION: the refusal message has to say
    // 「改成 `FROM <这一张>`」, and 「用平台预制镜像」 without a name is unusable.
    // ⚠️ AND NEITHER IS `digest`: it is the value written into a derived row's
    // `derived_from_digest`. If this projection stops carrying it, the writer has to
    // go re-read the anchor row to learn something this query already had — which is
    // the second walk over the anchors that `lineageVerdict` exists to avoid.
    expect(await h.manifests.listBuiltinAnchors()).toEqual([
      { ref: 'ghcr.io/platform/base:v1', digest: digest('d'), diffIds: ['sha256:root'] },
    ]);
  });

  it('⭐ 停用的 builtin 行仍然是锚点 —— 血统是历史事实，不随指针移动而变假', async () => {
    h.uow.run((tx) =>
      h.images.saveSync(
        tx,
        Image.create({
          id: 'img-base',
          name: 'ghcr.io/platform/base',
          ownerRef: null,
          isBuiltin: true,
          createdAt: NOW,
        }),
      ),
    );
    h.uow.run((tx) =>
      h.manifests.saveSync(
        tx,
        manifest({
          id: 'imf-base',
          imageId: 'img-base',
          version: 'v1',
          digest: digest('e'),
          diffIds: ['sha256:root'],
          isActive: false,
        }),
      ),
    );
    // MUTATION: 给查询加上 `eq(imageManifests.isActive, true)` ⇒ 本条红，而后果是
    // 「运维方把预制镜像换代」会让所有基于旧版构建的镜像突然注册不了。
    expect((await h.manifests.listBuiltinAnchors()).map((a) => a.ref)).toEqual([
      'ghcr.io/platform/base:v1',
    ]);
  });
});

/**
 * ⭐ `derived_from_digest`：血统校验算出来的「基于哪一张」必须真的落库（04 §7 ★血统）。
 *
 * 这一列是**唯一**记录「谁基于谁」的地方——`diff_ids` 只够重算一次比对，而重算要求那张锚点
 * 今天还在库里、且层列表没变过。落库的是**注册那一刻的事实**，删掉锚点也不影响它。
 */
describe('derived_from_digest 真的进了库，并且不可被后续写入改掉', () => {
  const ANCHOR = digest('c');

  it('roundtrip：写进去的锚点 digest 原样读得回来', () => {
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest({ derivedFromDigest: ANCHOR })));
    // MUTATION: 把 `saveSync` 的 values 里那行 `derivedFromDigest: manifest.derivedFromDigest`
    // 删掉 ⇒ 列取 NULL，本条红。
    expect(
      h.sqlite
        .prepare("SELECT derived_from_digest AS d FROM image_manifests WHERE id='imf-1'")
        .get(),
    ).toEqual({ d: ANCHOR });
  });

  it('rehydrate 读得回来，且 NULL 读成 null 而不是 undefined', async () => {
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest({ derivedFromDigest: ANCHOR })));
    expect((await h.manifests.findById('imf-1'))?.derivedFromDigest).toBe(ANCHOR);

    // ⚠️ NULL 必须读成 `null`。读成 `undefined` 会在 DTO 上变成「这个字段不存在」，而契约
    // 承诺的是 `string | null` —— 前端拿到的就不是它按契约生成的类型了。
    h.uow.run((tx) =>
      h.manifests.saveSync(
        tx,
        manifest({
          id: 'imf-root',
          version: 'root',
          digest: digest('f'),
          derivedFromDigest: null,
        }),
      ),
    );
    const root = await h.manifests.findById('imf-root');
    expect(root?.derivedFromDigest).toBeNull();
    expect(root?.derivedFromDigest).not.toBeUndefined();
  });

  it('⚠️ 血统是身份的一部分：`onConflictDoUpdate` 不许改它（I-IMG-7）', async () => {
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest({ derivedFromDigest: ANCHOR })));
    // 同一个 id 再存一次，带着**另一张锚点**。现实里 `activate` / 改 env 都会走到这条
    // upsert，而 `set:` 列表是唯一决定「哪些字段可变」的地方。
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest({ derivedFromDigest: digest('9') })));
    // MUTATION: 往 `set:` 里加一行 `derivedFromDigest` ⇒ 本条红。血统可变 = 「基于谁」
    // 可以被事后改写，而这一列存在的全部意义就是它记的是**注册那一刻**的事实。
    expect((await h.manifests.findById('imf-1'))?.derivedFromDigest).toBe(ANCHOR);
  });

  it('⭐ 没有外键：锚点行被删掉，派生行的血统记录照样在，也不挡删除', () => {
    // 这一条是「存 digest 而不是 manifest id、且刻意不建 FK」那三条理由的**可执行形式**。
    // 换成 `references(() => imageManifests.id)`：要么这次 DELETE 被 RESTRICT 挡下（运维方
    // 从此清不掉旧的预制镜像行），要么 CASCADE 把派生行一起删了。存 digest 则两者都不会
    // 发生——那张 base 的 bits 早就被派生镜像吸收了，血统是历史事实，不是活引用。
    h.uow.run((tx) =>
      h.images.saveSync(
        tx,
        Image.create({
          id: 'img-base',
          name: 'ghcr.io/platform/base',
          ownerRef: null,
          isBuiltin: true,
          createdAt: NOW,
        }),
      ),
    );
    h.uow.run((tx) =>
      h.manifests.saveSync(
        tx,
        manifest({ id: 'imf-base', imageId: 'img-base', version: 'v1', digest: ANCHOR }),
      ),
    );
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest({ derivedFromDigest: ANCHOR })));

    expect(() => h.uow.run((tx) => h.manifests.deleteSync(tx, 'imf-base'))).not.toThrow();
    expect(
      h.sqlite
        .prepare("SELECT derived_from_digest AS d FROM image_manifests WHERE id='imf-1'")
        .get(),
    ).toEqual({ d: ANCHOR });
    expect(h.sqlite.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('the two cross-row uniqueness rules (13 §2.4.2)', () => {
  it('`unique(image_id, digest)`: the same BITS enter the catalogue once', () => {
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest()));
    expect(() =>
      h.uow.run((tx) => h.manifests.saveSync(tx, manifest({ id: 'imf-2', version: 'v1' }))),
    ).toThrow(/UNIQUE/i);
  });

  it('`unique(image_id, version) WHERE is_active`: one tag has ONE live row', () => {
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest()));
    expect(() =>
      h.uow.run((tx) =>
        h.manifests.saveSync(tx, manifest({ id: 'imf-2', digest: digest('b'), isActive: true })),
      ),
    ).toThrow(/UNIQUE/i);
  });

  it('…but RETIRED rows of the same tag pile up freely — that IS the history', async () => {
    // ⚠️ THE MUTATION THIS CATCHES is a FULL `unique(image_id, version)` instead of a
    // PARTIAL one. That was the previous design, and it is what forced 「upgrading
    // edits the row in place」 — which in turn voided I-IMG-6 (immutable coordinate)
    // and both I-IMG-2/3 promises that historical references keep resolving. An index
    // is not an argument (13 §2.4.2 ★).
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest({ isActive: false })));
    h.uow.run((tx) =>
      h.manifests.saveSync(tx, manifest({ id: 'imf-2', digest: digest('b'), isActive: false })),
    );
    h.uow.run((tx) =>
      h.manifests.saveSync(tx, manifest({ id: 'imf-3', digest: digest('c'), isActive: true })),
    );
    const all = await h.manifests.listByImage('img-1');
    expect(all.map((m) => m.version)).toEqual(['latest', 'latest', 'latest']);
    expect(all.filter((m) => m.isActive).map((m) => m.id)).toEqual(['imf-3']);
    // Every retired row keeps ITS OWN digest — the identity a historical
    // `sandboxes.image_ref` points at can never have changed under it (I-IMG-7).
    expect(new Set(all.map((m) => m.digest)).size).toBe(3);
  });
});

describe('activate swaps the pointer inside ONE transaction (I-IMG-8)', () => {
  it('retires the incumbent and promotes the new row without ever having two live', async () => {
    const old = manifest();
    const next = manifest({ id: 'imf-2', digest: digest('b'), isActive: false });
    h.uow.run((tx) => h.manifests.saveSync(tx, old));
    h.uow.run((tx) => h.manifests.saveSync(tx, next));

    // ⚠️ `activate` 的第一参是 ref（后加的），此前只传了时间。
    next.activate('localhost:5001/platform/sandbox:v2', NOW);
    h.uow.run((tx) => {
      h.manifests.deactivateOthersSync(tx, 'img-1', 'latest', next.id);
      h.manifests.saveSync(tx, next);
    });

    const live = await h.manifests.listSelectable();
    expect(live.map((m) => m.id)).toEqual(['imf-2']);
    // …and the retired row is still THERE, with its own digest untouched (I-IMG-3 as a
    // structural guarantee rather than a promise).
    const retired = await h.manifests.findById('imf-1');
    expect(retired?.isActive).toBe(false);
    expect(retired?.digest).toBe(digest('a'));
  });
});

describe('the CHECKs and the cross-context RESTRICT', () => {
  it('`validation_status` is a closed 4-value set', () => {
    expect(() =>
      h.sqlite
        .prepare(
          `INSERT INTO image_manifests (id,image_id,version,base_image,digest,entrypoint_contract,
             supported_runtimes,resource_defaults,labels_required,validation_status,is_active,registered_at)
           VALUES ('x','img-1','t','b',?, '{}','[]','{}','[]','maybe',1,0)`,
        )
        .run(digest('d')),
    ).toThrow(/CHECK/i);
  });

  it('a sandbox referencing a manifest BLOCKS its delete (RESTRICT, 13 §2.4.5)', async () => {
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest()));
    h.sqlite
      .prepare(
        `INSERT INTO sandboxes (id, project_id, runtime, image_ref, headless, created_at, updated_at)
         VALUES ('sbx-1','prj-1','codex','imf-1',0,0,0)`,
      )
      .run();

    expect(await h.manifests.countReferencingSandboxes('imf-1')).toBe(1);
    // ⚠️ THE FK IS THE REAL GUARD; the count above only exists so the 409 can say HOW
    // MANY Tasks are holding the image instead of surfacing a raw constraint error.
    expect(() => h.uow.run((tx) => h.manifests.deleteSync(tx, 'imf-1'))).toThrow(/constraint/i);
  });

  it('refuses a sandbox pointing at a manifest that does not exist', () => {
    // Before 0010 `image_ref` was free text and this insert succeeded silently — the
    // column simply meant something different (a coordinate). Same name, two meanings
    // (04 §7 ⚠️); the FK is what makes only one of them possible.
    expect(() =>
      h.sqlite
        .prepare(
          `INSERT INTO sandboxes (id, project_id, runtime, image_ref, headless, created_at, updated_at)
           VALUES ('sbx-2','prj-1','codex','ghcr.io/agent-infra/sandbox:latest',0,0,0)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe('listSelectable applies BOTH door invariants — and ONLY those two', () => {
  it('hides retired rows (I-IMG-3) and invalid ones (I-IMG-2)', async () => {
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest()));
    h.uow.run((tx) =>
      h.manifests.saveSync(
        tx,
        manifest({ id: 'imf-2', version: 'v1', digest: digest('b'), isActive: false }),
      ),
    );
    h.uow.run((tx) =>
      h.manifests.saveSync(
        tx,
        manifest({
          id: 'imf-3',
          version: 'v2',
          digest: digest('c'),
          validation: ValidationOutcome.from(
            [{ code: 'IMAGE_TMUX_MISSING', path: 'labels.platform.tmux', message: 'x' }],
            [],
          ),
        }),
      ),
    );

    expect((await h.manifests.listSelectable()).map((m) => m.id)).toEqual(['imf-1']);
  });

  /**
   * ⚠️ THE THIRD CONDITION IS GONE, AND ITS ABSENCE NEEDS A CLAUSE OF ITS OWN.
   *
   * 原条款（存档）：本用例还断言过 `listSelectable('codex')` 与
   * `listSelectable('codex-mini')` 的差别——那时签名收一个 `runtimeId`，并在 JS 里做
   * `supportedRuntimes.includes(runtimeId)` 成员判定（写在 JS 而不是 SQL，是为了避开
   * `LIKE '%codex%'` 把 `codex-mini` 也匹配上的子串坑）。
   *
   * 那条筛选整条删掉了：它回答错了问题。`supportedRuntimes` 说的是**预装了什么**，
   * 而「可不可选」问的是**能不能跑**。血统落地后，任何合规镜像都自带 base 的
   * node/npm，任何 runtime 都装得上——用「没预装」去否决可选性，等于否认一个平台
   * 已经保证的能力，还会把那张 ⚠️ 卡（「未预装，需现装约 12.5 分钟」）永远藏起来。
   * 实测：诚实标注 `supportedRuntimes="codex"` 之后，`?runtimeId=claude-code` 返回 0 张，
   * 而那是平台当时唯一的镜像。
   */
  it('⭐ 不再按 supportedRuntimes 筛：只声明 codex 的镜像照样在可选集里', async () => {
    h.uow.run((tx) => h.manifests.saveSync(tx, manifest({ supportedRuntimes: ['codex'] })));
    // MUTATION: 把 `.filter((m) => m.supportedRuntimes.includes(runtimeId))` 加回
    // `listSelectable` ⇒ 本条红（它拿不到 runtimeId 了，只能连签名一起加回来）。
    const selectable = await h.manifests.listSelectable();
    expect(selectable.map((m) => m.id)).toEqual(['imf-1']);
    expect(selectable[0].supportedRuntimes).not.toContain('claude-code');
  });
});
