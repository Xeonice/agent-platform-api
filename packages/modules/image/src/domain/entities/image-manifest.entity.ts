import { AggregateRoot } from '@platform/shared-kernel';
import {
  ImageActivated,
  ImageConfigUpdated,
  ImageDeactivated,
  ImageDeleted,
  ImageRegistered,
  ImageValidated,
} from '../events/image-events';
import { ValidationOutcome } from '../value-objects/validation-outcome.vo';
import type { ValidationFinding } from '../value-objects/validation-outcome.vo';
import { ImageStateError } from '../errors/image-errors';

/**
 * Entry contract + scheduler defaults, redeclared inside the image domain.
 *
 * ⚠️ NOT A COPY-PASTE SLIP. `eslint-plugin-boundaries` forbids `domain → contracts`,
 * and these are stored aggregate state, not wire types. They are structurally
 * identical to the contract shapes so the application layer's mapping is a
 * pass-through that the compiler checks in both directions.
 */
export interface EntrypointContractVO {
  workdir: string;
  entrypoint: string[];
  healthcheckCmd?: string[];
}

export interface ResourceDefaultsVO {
  cores: number;
  ramMb: number;
  diskMb: number;
}

/** Stored form of a secret env value; the plaintext never enters the aggregate. */
export interface SealedEnvValueVO {
  blob: string;
  iv: string;
  authTag: string;
  keyId: string;
}

export interface StoredEnvEntry {
  key: string;
  secret: boolean;
  /** Present iff `!secret`. */
  value?: string;
  /** Present iff `secret` — I-IMG-5 「聚合内恒为密文」. */
  valueEncrypted?: SealedEnvValueVO;
}

export interface ImageConfigVO {
  env: StoredEnvEntry[];
  cmdOverride?: string[];
}

export interface ImageManifestProps {
  id: string;
  imageId: string;
  /** The TAG (or digest, when registered by digest) this row was resolved from. */
  version: string;
  baseImage: string;
  digest: string;
  entrypointContract: EntrypointContractVO;
  supportedRuntimes: string[];
  resourceDefaults: ResourceDefaultsVO;
  labelsRequired: string[];
  /**
   * `rootfs.diff_ids` frozen with the rest of the coordinate (04 §7 ★血统).
   *
   * ⚠️ IT IS STORED, NOT RE-FETCHED, AND THAT IS THE POINT OF STORING IT. The lineage
   * anchor has to survive a restart and an unreachable registry: asking the registry
   * every time a user registers an image would put `REGISTRY_UNREACHABLE` in the way
   * of a rule that has nothing to do with the network.
   *
   * ⚠️ PRE-SLICE ROWS CARRY `[]`, AND THE MIGRATION CANNOT DO BETTER. Rows written
   * before this column existed have no recoverable `diff_ids` — inventing one would be
   * `'sha256:unresolved'` wearing a new hat (I-IMG-6). `[]` reads as 「不可作为锚点、
   * 也无法被验证为派生」, which is the honest, fail-closed meaning.
   */
  diffIds: string[];
  /**
   * WHICH built-in anchor this image was found to descend from — the answer the
   * lineage check already computed and used to throw away (04 §7 ★血统).
   *
   * ⚠️ IT IS THE ANCHOR'S **DIGEST**, NOT ITS `image_manifests.id`, AND IT IS NOT A
   * FOREIGN KEY. Both halves are deliberate; see `derivedFromDigest` in
   * `infrastructure/persistence/schema/image.sqlite.ts` for the three reasons.
   *
   * ⚠️ `null` HAS TWO MEANINGS AND THEY ARE NOT INTERCHANGEABLE:
   *   ① the row IS a platform root (`Image.isBuiltin`) — it has no platform ancestor
   *      by construction, which is exactly why it is exempt from the lineage check;
   *   ② the row predates this column — a pre-slice row whose `diffIds` is also `[]`,
   *      so no ancestor can be recovered and none may be invented (I-IMG-6).
   * Reading `null` as 「没有基于任何平台镜像」 would call ② a policy violation, and
   * reading it as ① would claim a pre-slice user image is a platform root. The
   * distinguishing fact is `isBuiltin`, which lives one row over in `images`.
   *
   * ⚠️ IMMUTABLE WITH THE REST OF THE COORDINATE (I-IMG-7). It records what was true
   * at THIS registration; a later `activate` / config edit must not restate it.
   */
  derivedFromDigest: string | null;
  validation: ValidationOutcome;
  config: ImageConfigVO | null;
  isActive: boolean;
  registeredAt: Date;
}

/**
 * `ImageManifest` — AGGREGATE ROOT (docs/backend/23 §9.1 裁决 D-8).
 *
 * ⚠️ IT IS A ROOT AND NOT AN ENTITY INSIDE `Image` BECAUSE `sandboxes.image_ref`
 * REFERENCES IT (13 §2.4.5). A cross-aggregate reference must point at a root;
 * pointing at another aggregate's internal entity is the textbook anti-pattern.
 * The price is that the two cross-row uniqueness rules (`unique(image_id, digest)`
 * and `unique(image_id, version) WHERE is_active`) are not aggregate invariants —
 * they are application checks plus DB unique indexes (23 §4.6 第三类).
 *
 * ⚠️ THE ROW IS IMMUTABLE EXCEPT FOR TWO FIELDS (I-IMG-7). `digest` / `baseImage` /
 * `version` / `derivedFromDigest` are never UPDATEd — upgrading an image is INSERT a
 * new row + move the `is_active` pointer, NOT edit in place. That is what turns I-IMG-3
 * (「is_active=false 的引用仍合法」) from a promise into a STRUCTURAL guarantee: a
 * historical `sandboxes.image_ref` points at a row whose bits cannot have changed.
 * The previous design mutated `digest` in place and needed a compensating
 * `sandboxes.image_digest` snapshot column to stay honest — needing a compensating
 * column is the signal that you are fighting the schema (13 §2.4.2 ★).
 */
export class ImageManifest extends AggregateRoot<string> {
  readonly imageId: string;
  readonly version: string;
  readonly baseImage: string;
  readonly digest: string;
  readonly entrypointContract: EntrypointContractVO;
  readonly supportedRuntimes: string[];
  readonly resourceDefaults: ResourceDefaultsVO;
  readonly labelsRequired: string[];
  /** The lineage anchor — immutable with the rest of the coordinate (I-IMG-7). */
  readonly diffIds: string[];
  /** Digest of the built-in anchor this row descends from; `null` — see the prop. */
  readonly derivedFromDigest: string | null;
  readonly registeredAt: Date;

  private _validation: ValidationOutcome;
  private _config: ImageConfigVO | null;
  private _isActive: boolean;

  private constructor(props: ImageManifestProps) {
    super(props.id);
    this.imageId = props.imageId;
    this.version = props.version;
    this.baseImage = props.baseImage;
    this.digest = props.digest;
    this.entrypointContract = props.entrypointContract;
    this.supportedRuntimes = props.supportedRuntimes;
    this.resourceDefaults = props.resourceDefaults;
    this.labelsRequired = props.labelsRequired;
    this.diffIds = props.diffIds;
    this.derivedFromDigest = props.derivedFromDigest;
    this._validation = props.validation;
    this._config = props.config;
    this._isActive = props.isActive;
    this.registeredAt = props.registeredAt;
  }

  /**
   * Build a NEW manifest row.
   *
   * ⚠️ `digest` IS CHECKED HERE, NOT ONLY BY THE DB (I-IMG-6). The CHECK constraint
   * only knows 「non-empty」, and `'sha256:unresolved'` is non-empty — the exact
   * placeholder the whole slice exists to delete (04 §7 ★). A shape check at the one
   * construction site is what makes 「不可变坐标」 mean something.
   */
  static create(props: ImageManifestProps, ref: string): ImageManifest {
    if (!/^sha256:[0-9a-f]{64}$/.test(props.digest)) {
      throw new ImageStateError(
        `refusing to store manifest ${props.id} with a non-digest coordinate '${props.digest}' ` +
          '(I-IMG-6: the digest IS the row identity)',
      );
    }
    const m = new ImageManifest(props);
    m.raise(new ImageRegistered(props.id, props.imageId, ref, props.digest, props.registeredAt));
    return m;
  }

  /** Rebuild from a row — no events, no digest re-check (the row already passed it). */
  static rehydrate(props: ImageManifestProps): ImageManifest {
    return new ImageManifest(props);
  }

  get validation(): ValidationOutcome {
    return this._validation;
  }

  get config(): ImageConfigVO | null {
    return this._config;
  }

  get isActive(): boolean {
    return this._isActive;
  }

  /** Write back a fresh verdict for THESE bits (04 §7 时刻②). */
  recordValidation(outcome: ValidationOutcome, ref: string, at: Date): void {
    this._validation = outcome;
    this.raise(new ImageValidated(this.id, ref, outcome.status, at));
  }

  /**
   * Make this row the current version of its tag.
   *
   * ⚠️ REFUSES AN `invalid` ROW (I-IMG-9, 27 §6 → `INVALID_STATE` 409). Same source as
   * I-IMG-2: something the create door will not let a Task reference must not be
   * settable as 「the current version」 either — otherwise the catalogue advertises a
   * default that every Task creation then rejects.
   */
  activate(ref: string, at: Date): void {
    if (this._validation.status === 'invalid') {
      throw new ImageStateError(
        `manifest ${this.id} is 'invalid' and cannot be activated (I-IMG-9); ` +
          're-validate it or register a fixed image first',
      );
    }
    this._isActive = true;
    this.raise(new ImageActivated(this.id, ref, at));
  }

  /** Retire this row: it leaves the选项 list, historical references stay valid. */
  deactivate(ref: string, at: Date): void {
    this._isActive = false;
    this.raise(new ImageDeactivated(this.id, ref, at));
  }

  /**
   * Replace the run parameters.
   *
   * `env` arrives already validated (`EnvVarSet`, 构造即校验) and already sealed for
   * secrets — the aggregate never sees a plaintext secret (I-IMG-5).
   */
  updateConfig(config: ImageConfigVO, ref: string, at: Date): void {
    this._config = config;
    this.raise(new ImageConfigUpdated(this.id, ref, at));
  }

  /**
   * `DELETE /api/images/:id` —— 行即将消失，事件是唯一的去处。
   *
   * ⚠️ 必须在 `deleteSync` 之前调用、并在**同一个事务**里 publish（与
   * `Project.markDeleted` 同一条纪律：13 §2.8.2「审计必须在主体被删除之后继续存在」）。
   */
  markDeleted(ref: string, at: Date): void {
    this.raise(new ImageDeleted(this.id, ref, at));
  }

  /**
   * Findings behind the CURRENT status, as stored in the single `validation_errors`
   * column (13 §2.4.2). `invalid` ⇒ errors, `warning` ⇒ warnings, otherwise none.
   */
  storedFindings(): ValidationFinding[] | null {
    if (this._validation.status === 'invalid') return [...this._validation.errors];
    if (this._validation.status === 'warning') return [...this._validation.warnings];
    return null;
  }
}
