import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, check, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  EntrypointContractVO,
  ImageConfigVO,
  ResourceDefaultsVO,
} from '../../../domain/entities/image-manifest.entity';
import type { ValidationFinding } from '../../../domain/value-objects/validation-outcome.vo';

/**
 * Drizzle SQLite schema for the image context (docs/backend/13 §2.4).
 *
 * Cross-dialect discipline (13 §1): enums = `text` + CHECK (never `pgEnum`); no
 * `.array()`; timestamps are JS `Date` (integer timestamp mode); JSON columns are
 * text(json). Each CHECK carries its I-* id.
 */

export const images = sqliteTable('images', {
  id: text('id').primaryKey(),
  /** WITHOUT a version — `ghcr.io/agent-infra/sandbox`, never `…:latest` (13 §2.4.1). */
  name: text('name').notNull().unique(),
  /** Multi-user placeholder; always NULL today. */
  ownerRef: text('owner_ref'),
  isBuiltin: integer('is_builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const imageManifests = sqliteTable(
  'image_manifests',
  {
    id: text('id').primaryKey(),
    imageId: text('image_id')
      .notNull()
      .references(() => images.id, { onDelete: 'cascade' }),
    /**
     * The TAG this row was resolved from (`v1.0` / `latest`), or the digest when the
     * user registered by digest.
     *
     * ⚠️ IT IS NOT THE IDENTITY AND IT IS NOT UNIQUE ON ITS OWN. A re-pushed tag
     * produces a SECOND row (13 §2.4.2 ★). The previous design had
     * `unique(image_id, version)` and let that index decide the product behaviour —
     * 「a tag can only have one row」 ⇒ 「upgrading edits the row in place」 — which
     * quietly voided I-IMG-6 (immutable coordinate) and both I-IMG-2/3 promises that
     * historical references keep resolving. An index is not an argument.
     */
    version: text('version').notNull(),
    baseImage: text('base_image').notNull(),
    /** IMMUTABLE identity of this row (I-IMG-6 / I-IMG-7 / testkit IS-01). */
    digest: text('digest').notNull(),
    entrypointContract: text('entrypoint_contract', { mode: 'json' })
      .$type<EntrypointContractVO>()
      .notNull(),
    supportedRuntimes: text('supported_runtimes', { mode: 'json' }).$type<string[]>().notNull(),
    resourceDefaults: text('resource_defaults', { mode: 'json' })
      .$type<ResourceDefaultsVO>()
      .notNull(),
    labelsRequired: text('labels_required', { mode: 'json' }).$type<string[]>().notNull(),
    /**
     * `rootfs.diff_ids` — the LINEAGE ANCHOR (04 §7 ★血统, 13 §2.4.2).
     *
     * ⚠️ IT IS PERSISTED RATHER THAN RE-RESOLVED BECAUSE THE RULE MUST OUTLIVE THE
     * NETWORK. Every registration compares the incoming image against the anchors
     * already in this table; re-asking the registry for each of them would make an
     * offline deployment unable to register anything, and would drag
     * `REGISTRY_UNREACHABLE` (the group's only retryable code) into a check that is
     * pure local bookkeeping.
     *
     * ⚠️ DEFAULT `'[]'` IS WHAT BACKFILLS PRE-SLICE ROWS, AND ITS MEANING IS 「未知」,
     * NOT 「无层」. `isDerivedFrom` refuses an empty base as an anchor, so such a row
     * can neither vouch for a new image nor be shown to be derived — fail-closed, which
     * is the only honest reading of a value the migration could not recover.
     */
    diffIds: text('diff_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /**
     * WHICH built-in anchor this row descends from — the half of the lineage verdict
     * that used to be computed and thrown away (04 §7 ★血统).
     *
     * The check already walks every anchor and knows which one matched; keeping only
     * 「过 / 不过」 meant the platform could not answer 「谁基于谁」 at all — no
     * 「基于 X」 on the card, no way to tell an operator which customer images went
     * stale when a new base ships, and no ground to stand on for an automatic rebase.
     *
     * ── 为什么存**锚点的 digest**，而不是它的 `image_manifests.id` ─────────────
     * ① **血统是历史事实，不是活引用。** Deleting a base row must NOT leave a derived
     *    row's lineage dangling, and must NOT be blocked by an FK RESTRICT — those
     *    base bits were absorbed into the derived image the moment it was built, and
     *    they stay absorbed after the anchor row is gone.
     * ② **digest 是内容寻址的.** It keeps pointing at the same bits with the anchor row
     *    deleted, re-seeded under a new id, or registered on another deployment
     *    entirely; a manifest id is a ROW POINTER, and a deleted row makes it garbage.
     *
     * ── ③ 刻意不建外键，而且这句话是写给下一个读者的 ─────────────────────────
     * 13 §2.9 records THREE 「两张表都在、FK 却没建」 debts (`sandboxes.project_id`,
     * `runtime_installations.sandbox_id`, `sandbox_state_transitions.sandbox_id`) —
     * rows that read like live constraints and are not. **This column is not a fourth
     * one.** It cannot be an FK even in principle: reason ① requires the reference to
     * SURVIVE the target's deletion, which is the exact opposite of what RESTRICT or
     * CASCADE would do, and reason ② means the value is not a key into any table's
     * primary key at all (`digest` is unique only per `image_id`). 「没建」 here is
     * the design, not an omission — do not 「补上」 it.
     *
     * ── NULL 的两种语义，读的时候必须分清 ────────────────────────────────────
     * ① 预制根镜像（`images.is_builtin`）—— 它就是锚点，没有平台祖先，所以豁免血统
     *    校验；② 切片前的存量行 —— 它的 `diff_ids` 同样是 `[]`，祖先不可复原，也不
     *    准编造（I-IMG-6）。两者都写 NULL，区分的事实是隔壁 `images.is_builtin`。
     */
    derivedFromDigest: text('derived_from_digest'),
    validationStatus: text('validation_status').notNull().default('pending'),
    /** Findings behind the current status; non-empty when `invalid` (testkit IS-03). */
    validationErrors: text('validation_errors', { mode: 'json' }).$type<ValidationFinding[]>(),
    /**
     * 「这个版本现在可不可选」 — ONE meaning, deliberately (13 §2.4.2 ★★).
     *
     * ⚠️ IT IS NOT SPLIT INTO 「user disabled」 vs 「superseded」. The observable
     * behaviour of the two is identical (not selectable from now on, historical
     * sandbox references unaffected), and two states with one behaviour is a second
     * source of truth that must be kept in sync forever. [启用] on an old row is a
     * ROLLBACK, not an exception path — which is why it shares one endpoint with
     * 「更新到新版本」: both are 「move the pointer」.
     */
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    /** `{ env: [...], cmdOverride?: [...] }`; secret values stored sealed (I-IMG-5). */
    imageConfig: text('image_config', { mode: 'json' }).$type<ImageConfigVO>(),
    /**
     * When this row was INSERTed — which, because `digest` never changes, is also the
     * instant the coordinate was resolved. `ImageManifestDto.resolvedAt` maps from
     * here rather than from a second column, since a second column could only ever
     * disagree with this one (I-IMG-7 makes them the same event by construction).
     */
    registeredAt: integer('registered_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => ({
    // 13 §2.4.2: 4-value 三级反馈 enum (+ `pending` before the first verdict)
    validationStatusCk: check(
      'image_manifests_validation_status_ck',
      sql`${t.validationStatus} IN ('pending','valid','warning','invalid')`,
    ),
    // I-IMG-6. ⚠️ The DB can only say 「non-empty」 — and `'sha256:unresolved'` is
    // non-empty. The SHAPE check that actually matters lives in
    // `ImageManifest.create`; this is the belt behind it.
    digestCk: check(
      'image_manifests_digest_ck',
      sql`${t.digest} IS NOT NULL AND length(${t.digest}) > 0`,
    ),
    // 身份: the same bits enter the catalogue once per image (13 §2.4.2)
    digestUq: uniqueIndex('uq_manifest_digest').on(t.imageId, t.digest),
    // 当前指针: one tag has at most ONE live row (I-IMG-8). PARTIAL unique index —
    // supported by both dialects (13 §1), which is why the retired rows may pile up
    // under the same `version` without colliding.
    activeTagUq: uniqueIndex('uq_manifest_active_tag')
      .on(t.imageId, t.version)
      .where(sql`${t.isActive}`),
    validationStatusIdx: index('idx_manifest_validation_status').on(t.validationStatus),
    imageIdx: index('idx_manifest_image').on(t.imageId),
  }),
);

export const imageSchema = { images, imageManifests };
export type ImageRow = typeof images.$inferSelect;
export type ImageManifestRow = typeof imageManifests.$inferSelect;
