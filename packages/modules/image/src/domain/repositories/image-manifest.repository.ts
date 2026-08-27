import type { Tx } from '@platform/shared-kernel';
import type { ImageManifest } from '../entities/image-manifest.entity';

export interface ImageManifestRepository {
  findById(id: string): Promise<ImageManifest | null>;
  /** Identity lookup — `unique(image_id, digest)` makes this at most one row. */
  findByDigest(imageId: string, digest: string): Promise<ImageManifest | null>;
  /** The CURRENT version of one tag — `unique(image_id, version) WHERE is_active`. */
  findActiveByVersion(imageId: string, version: string): Promise<ImageManifest | null>;
  listByImage(imageId: string): Promise<ImageManifest[]>;
  /** Every manifest, newest first. The management page shows history too (27 §6). */
  listAll(): Promise<ImageManifest[]>;
  /**
   * The wizard-selectable set: `is_active` ∧ not `invalid` (I-IMG-2 + I-IMG-3).
   *
   * ⚠️ IT NO LONGER TAKES A `runtimeId`, AND REMOVING THE PARAMETER IS THE FIX, NOT A
   * SIMPLIFICATION. The old third condition was 「declares `runtimeId` in
   * `supportedRuntimes`」 — i.e. an image was hidden from a runtime it merely had not
   * PREINSTALLED. Lineage already guarantees every compliant image carries the base's
   * node/npm, so that condition denied a capability the platform guarantees, and it hid
   * exactly the card whose ⚠️ line exists to say 「未预装，需现装约 12.5 分钟」.
   * Measured: an image honestly labelled `supportedRuntimes="codex"` made
   * `GET /api/images?runtimeId=claude-code` return ZERO rows — on a platform whose only
   * image was that one. A parameter left in place but ignored would have rotted; the
   * signature is where the change has to be visible.
   */
  listSelectable(): Promise<ImageManifest[]>;
  /**
   * `rootfs.diff_ids` + coordinate of every manifest belonging to a BUILT-IN image —
   * the lineage anchors a user-supplied image is checked against (04 §7 ★血统).
   *
   * ⚠️ A PROJECTION, NOT `ImageManifest[]`, ON PURPOSE. The caller needs three fields;
   * returning aggregates would either be an N+1 (`images` then `listByImage` per row)
   * or a join that rehydrates state nobody reads. The `ref` rides along so the refusal
   * can NAME the base to build `FROM` instead of saying 「用平台预制镜像」 and leaving
   * the user to guess which one.
   *
   * ⚠️ `digest` IS HERE BECAUSE THE MATCH IS NOW RECORDED, NOT ONLY JUDGED. The check
   * already knows which anchor a candidate descends from; that answer is written to
   * `image_manifests.derived_from_digest`, and it is the ANCHOR'S DIGEST rather than
   * its row id so that deleting the anchor cannot dangle the record (see the column's
   * comment). Fetching it in this one query is what keeps the writer from re-reading
   * the anchor row just to learn a value this projection already had in hand.
   *
   * ⚠️ IT DOES NOT FILTER ON `is_active`. Lineage is a HISTORICAL fact about bits: an
   * image legitimately built on `base:v1` does not stop being derived when the operator
   * retires v1 in favour of v2. Filtering here would make 「换一版预制镜像」 silently
   * un-registerable for everything built on the old one.
   */
  listBuiltinAnchors(): Promise<Array<{ ref: string; digest: string; diffIds: string[] }>>;
  saveSync(tx: Tx, manifest: ImageManifest): void;
  /**
   * Retire every OTHER active row of the same tag, in the caller's transaction.
   *
   * ⚠️ IT MUST BE THE SAME TRANSACTION AS THE ACTIVATE. `unique(image_id, version)
   * WHERE is_active` means the two rows are momentarily both active in between; only a
   * transaction makes that window unobservable. Two separate writes would either wedge
   * on the index or leave the tag with no current version at all (23 I-IMG-8).
   */
  deactivateOthersSync(tx: Tx, imageId: string, version: string, keepId: string): void;
  deleteSync(tx: Tx, id: string): void;
  /** How many sandboxes reference this manifest — the RESTRICT pre-check for DELETE. */
  countReferencingSandboxes(manifestId: string): Promise<number>;
}

export const IMAGE_MANIFEST_REPOSITORY = Symbol('ImageManifestRepository');
