import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import type { Tx } from '@platform/shared-kernel';
import { formatImageRef } from '@platform/contracts';
import { ImageManifest } from '../../../domain/entities/image-manifest.entity';
import { ValidationOutcome } from '../../../domain/value-objects/validation-outcome.vo';
import type { ImageValidationStatus } from '../../../domain/value-objects/validation-outcome.vo';
import type { ImageManifestRepository } from '../../../domain/repositories/image-manifest.repository';
import { images, imageManifests, type ImageManifestRow } from '../schema/image.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

@Injectable()
export class SqliteImageManifestRepository implements ImageManifestRepository {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async findById(id: string): Promise<ImageManifest | null> {
    const row = this.db.select().from(imageManifests).where(eq(imageManifests.id, id)).get();
    return row ? toDomain(row) : null;
  }

  async findByDigest(imageId: string, digest: string): Promise<ImageManifest | null> {
    const row = this.db
      .select()
      .from(imageManifests)
      .where(and(eq(imageManifests.imageId, imageId), eq(imageManifests.digest, digest)))
      .get();
    return row ? toDomain(row) : null;
  }

  async findActiveByVersion(imageId: string, version: string): Promise<ImageManifest | null> {
    const row = this.db
      .select()
      .from(imageManifests)
      .where(
        and(
          eq(imageManifests.imageId, imageId),
          eq(imageManifests.version, version),
          eq(imageManifests.isActive, true),
        ),
      )
      .get();
    return row ? toDomain(row) : null;
  }

  async listByImage(imageId: string): Promise<ImageManifest[]> {
    return this.db
      .select()
      .from(imageManifests)
      .where(eq(imageManifests.imageId, imageId))
      .orderBy(desc(imageManifests.registeredAt))
      .all()
      .map(toDomain);
  }

  async listAll(): Promise<ImageManifest[]> {
    return this.db
      .select()
      .from(imageManifests)
      .orderBy(desc(imageManifests.registeredAt))
      .all()
      .map(toDomain);
  }

  /**
   * The wizard's dropdown (27 §6 「向导下拉」): `is_active` (I-IMG-3) ∧ not `invalid`
   * (I-IMG-2). TWO conditions, not three.
   *
   * ⚠️ 「∧ declares the chosen runtime」 WAS DELETED IN 2026-08 AND MUST NOT COME BACK.
   * It read `m.supportedRuntimes.includes(runtimeId)` and it answered the wrong
   * question: `supportedRuntimes` says what the image PREINSTALLS, while selectability
   * asks whether the runtime CAN RUN there. Since every compliant image is now verified
   * to descend from a platform base (04 §7 ★血统), node/npm are present by construction
   * and any runtime can be installed on any compliant image — so the filter was denying
   * a capability the platform guarantees. It also hid the one card whose ⚠️ line exists
   * to warn 「未预装，需现装约 12.5 分钟」, i.e. the user could not even choose the
   * option the warning was written for. Preinstall status belongs in
   * `getInstallPlan()`'s verdict (0 秒 vs 753 秒), never in visibility.
   */
  async listSelectable(): Promise<ImageManifest[]> {
    return this.db
      .select()
      .from(imageManifests)
      .where(and(eq(imageManifests.isActive, true), ne(imageManifests.validationStatus, 'invalid')))
      .orderBy(desc(imageManifests.registeredAt))
      .all()
      .map(toDomain);
  }

  /**
   * Lineage anchors: `diff_ids` + coordinate + digest of every manifest under a
   * BUILT-IN image.
   *
   * One join, no aggregate rehydration — the caller compares layer lists and, when it
   * refuses, prints a `ref` the user can literally put after `FROM`; when it admits,
   * it stores the matched anchor's `digest` as the derived row's lineage record.
   */
  async listBuiltinAnchors(): Promise<Array<{ ref: string; digest: string; diffIds: string[] }>> {
    return this.db
      .select({
        name: images.name,
        version: imageManifests.version,
        digest: imageManifests.digest,
        diffIds: imageManifests.diffIds,
      })
      .from(imageManifests)
      .innerJoin(images, eq(imageManifests.imageId, images.id))
      .where(eq(images.isBuiltin, true))
      .orderBy(desc(imageManifests.registeredAt))
      .all()
      .map((r) => ({
        ref: formatImageRef(r.name, r.version),
        digest: r.digest,
        diffIds: r.diffIds,
      }));
  }

  saveSync(_tx: Tx, manifest: ImageManifest): void {
    this.db
      .insert(imageManifests)
      .values({
        id: manifest.id,
        imageId: manifest.imageId,
        version: manifest.version,
        baseImage: manifest.baseImage,
        digest: manifest.digest,
        entrypointContract: manifest.entrypointContract,
        supportedRuntimes: manifest.supportedRuntimes,
        resourceDefaults: manifest.resourceDefaults,
        labelsRequired: manifest.labelsRequired,
        diffIds: manifest.diffIds,
        derivedFromDigest: manifest.derivedFromDigest,
        validationStatus: manifest.validation.status,
        validationErrors: manifest.storedFindings(),
        isActive: manifest.isActive,
        imageConfig: manifest.config,
        registeredAt: manifest.registeredAt,
      })
      .onConflictDoUpdate({
        target: imageManifests.id,
        // ⚠️ THE `set` LIST **IS** I-IMG-7. `digest` / `version` / `base_image` /
        // `diff_ids` / `derived_from_digest` are absent on purpose: they are this
        // row's identity, and upgrading an image is INSERT + pointer swap, never an
        // in-place edit (13 §2.4.2 ★). Adding one of them here would dismantle the
        // invariant from the one place nobody re-reads — for `derived_from_digest`
        // specifically, a mutable lineage means the answer to 「基于谁」 can be
        // rewritten after the fact while every image registered against it keeps its
        // old verdict.
        set: {
          validationStatus: manifest.validation.status,
          validationErrors: manifest.storedFindings(),
          isActive: manifest.isActive,
          imageConfig: manifest.config,
        },
      })
      .run();
  }

  deactivateOthersSync(tx: Tx, imageId: string, version: string, keepId: string): void {
    void tx;
    this.db
      .update(imageManifests)
      .set({ isActive: false })
      .where(
        and(
          eq(imageManifests.imageId, imageId),
          eq(imageManifests.version, version),
          eq(imageManifests.isActive, true),
          ne(imageManifests.id, keepId),
        ),
      )
      .run();
  }

  deleteSync(_tx: Tx, id: string): void {
    this.db.delete(imageManifests).where(eq(imageManifests.id, id)).run();
  }

  /**
   * How many sandboxes still point at this manifest.
   *
   * ⚠️ RAW SQL RATHER THAN AN IMPORT OF THE `sandboxes` TABLE, AND FOR A CONCRETE
   * REASON: `sandbox` already depends on `image` (its schema declares the FK direction
   * in the migration), so importing `@platform/sandbox` here would close a PACKAGE
   * cycle. The FK itself is still the real guard — this query only exists so the 409
   * can say HOW MANY Tasks are holding the image instead of surfacing a bare
   * `SQLITE_CONSTRAINT_FOREIGNKEY`.
   */
  async countReferencingSandboxes(manifestId: string): Promise<number> {
    const row = this.db.get<{ n: number }>(
      sql`select count(*) as n from sandboxes where image_ref = ${manifestId}`,
    );
    return row?.n ?? 0;
  }
}

function toDomain(row: ImageManifestRow): ImageManifest {
  const status = row.validationStatus as ImageValidationStatus;
  const findings = row.validationErrors ?? [];
  return ImageManifest.rehydrate({
    id: row.id,
    imageId: row.imageId,
    version: row.version,
    baseImage: row.baseImage,
    digest: row.digest,
    entrypointContract: row.entrypointContract,
    supportedRuntimes: row.supportedRuntimes,
    resourceDefaults: row.resourceDefaults,
    labelsRequired: row.labelsRequired,
    diffIds: row.diffIds,
    derivedFromDigest: row.derivedFromDigest,
    // 13 §2.4.2 has ONE findings column; `validation_status` says which bucket it is.
    validation: ValidationOutcome.rehydrate(
      status,
      status === 'invalid' ? findings : [],
      status === 'warning' ? findings : [],
    ),
    config: row.imageConfig,
    isActive: row.isActive,
    registeredAt: row.registeredAt,
  });
}
