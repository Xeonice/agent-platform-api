import type { ImageSpecManifest } from './image-spec.contract';

/**
 * Cross-context facade (26 §7 第 7 条): the `sandbox` context needs, at the create
 * door and again at provision, the frozen coordinate of the image a Task runs —
 * WITHOUT importing the `image` domain. Living in `contracts` keeps both sides
 * boundaries-clean and avoids a package cycle (mirrors `ProjectFacade`).
 *
 * ⚠️ EVERY METHOD HERE IS A DATABASE READ. NONE OF THEM GOES TO THE NETWORK, and
 * that is the whole design (04 §7): `resolve()` runs at registration and at
 * re-validation, both of which are user-initiated and may fail loudly. The create
 * door is synchronous, side-effect free and `retryable:false` BY CONSTRUCTION; a
 * registry round-trip there would introduce `REGISTRY_UNREACHABLE` (502,
 * retryable:true) — the first 「再试一次说不定就好了」 rejection in a door whose
 * answer is always 「this request, as written, is not accepted」. Keep the network
 * in the image module's two entry points and the door stays a door.
 */
export interface TaskImageSelection {
  /** `image_manifests.id` — the value that lands in `sandboxes.image_ref` (13 §2.4.5). */
  manifestId: string;
  /** Repository coordinate the provider pulls (`ghcr.io/x/y:tag`), NOT the manifest id. */
  ref: string;
  /** The digest frozen at registration (04 §7 时刻①). Real, never a placeholder. */
  digest: string;
  /** Runtime projection of `manifest.entrypointContract.entrypoint`. */
  entrypoint?: string[];
  manifest: ImageSpecManifest;
  resolvedAt: string;
  /**
   * The image's run parameters, ALREADY MERGED and with secrets decrypted — ready to
   * hand to `provider.create({ env })`.
   *
   * ⚠️ ONLY `findTaskImage` FILLS IT (时刻④), never `resolveForTask` (时刻③). The
   * create door has no use for env, and decrypting secrets for a request that may be
   * refused a line later is privilege nobody asked for.
   *
   * ⚠️ CREDENTIALS ARE **NOT** IN HERE, AND MUST NOT BE. 「凭证永远赢」 is guaranteed by
   * ORDER — the provision workflow spreads this map first and the credential env last
   * (05 §4.1) — not by anything this map knows about credential names.
   */
  env?: Record<string, string>;
}

/**
 * ⚠️ 两个码，因为**用户要做的事不同**（04 §4 四类分类法）：
 *
 * - `INVALID_IMAGE_REFERENCE` —— 你写的这个地址本身不合法（空白/控制字符）。出路是**改地址**。
 * - `IMAGE_NOT_REGISTERED` —— 地址没问题，但平台没有一张**活的**镜像在这个坐标上。
 *   出路是**去镜像管理**（注册一张，或把某个停用的版本启用回来）。
 *
 * 合成一个码会让全新部署的第一条错误说成「你的镜像地址里有不可见字符」——
 * 而用户什么都没填。前端文案按顶层码查，一个码只能配一句话。
 */
export type ImageAccessErrorCode = 'INVALID_IMAGE_REFERENCE' | 'IMAGE_NOT_REGISTERED';

/** Boundaries-safe error the facade throws; the sandbox door maps its `code` to HTTP. */
export class ImageAccessError extends Error {
  constructor(
    readonly code: ImageAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImageAccessError';
  }
}

export interface ImageFacade {
  /**
   * 时刻③ — the create door. `selector` is either an `image_manifests.id` or a
   * repository coordinate; either way the row must be `is_active` (I-IMG-3) and not
   * `invalid` (I-IMG-2), and the answer carries the digest frozen at registration.
   *
   * `undefined` ⇒ the platform default image (`SANDBOX_DEFAULT_IMAGE`).
   *
   * @throws ImageAccessError when no such selectable image exists.
   */
  resolveForTask(selector?: string): Promise<TaskImageSelection>;

  /**
   * 时刻④ — provision reads the coordinate back by manifest id, so what reaches
   * `provider.create()` is `ref@digest` rather than a tag. Returns `null` for a
   * pre-image-slice sandbox row (its `image_ref` is NULL — see 13 §2.1 迁移).
   */
  findTaskImage(manifestId: string): Promise<TaskImageSelection | null>;
}

export const IMAGE_FACADE = Symbol('ImageFacade');
