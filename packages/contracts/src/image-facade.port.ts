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
 * - `IMAGE_PROVIDER_MISMATCH` —— 地址没问题、镜像也是活的，但它**跑不在这一档上**
 *   （ADR 决策 C：两档的预制镜像不再是同一张）。出路是**换一档，或换一张这一档的镜像**
 *   —— 与上面两条都不同：改地址没用，去镜像管理注册也没用。
 *
 * 合成一个码会让全新部署的第一条错误说成「你的镜像地址里有不可见字符」——
 * 而用户什么都没填。前端文案按顶层码查，一个码只能配一句话。
 */
export type ImageAccessErrorCode =
  'INVALID_IMAGE_REFERENCE' | 'IMAGE_NOT_REGISTERED' | 'IMAGE_PROVIDER_MISMATCH';

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

/**
 * 一张**已注册**镜像在平台库里的样子 —— 诊断第 ⑧ 项第 4 步要的全部事实
 * （P21-5 §9A：「有没有注册进平台且 `validationStatus = valid`」）。
 *
 * ⚠️ 它与 `TaskImageSelection` 不是同一件事，也**不能**用后者代替：`resolveForTask`
 * 在「没注册」「停用了」「invalid」三种情况下都只抛一个 `IMAGE_NOT_REGISTERED`，
 * 而诊断要说的恰恰是它们的区别 —— 未注册要重启平台等播种，停用要去启用，invalid 要
 * 换镜像。把三件事合成一个异常，诊断就只能说「镜像不可用」，也就是 P21-5 §9A 明令
 * 禁止的那种合成。
 */
export interface RegisteredImageSummary {
  manifestId: string;
  /** 库里那一行的完整坐标（`registry/repo:tag`），可能与查询用的 ref 大小写/隐式 tag 不同。 */
  ref: string;
  digest: string;
  /** `valid` / `warning` / `invalid` —— 第 4 步要的就是这一位。 */
  validationStatus: string;
  isActive: boolean;
  /** `ImageSeeder` 以 `builtin:true` 播种的那一张（I-IMG-4：不可删除，只可禁用）。 */
  isBuiltin: boolean;
  entrypoint?: string[];
}

export interface ImageFacade {
  /**
   * 时刻③ — the create door. `selector` is either an `image_manifests.id` or a
   * repository coordinate; either way the row must be `is_active` (I-IMG-3) and not
   * `invalid` (I-IMG-2), and the answer carries the digest frozen at registration.
   *
   * `undefined` ⇒ **这一档**的预制镜像（`builtinImageRefFor(provider)`）。
   *
   * ══ 为什么它要知道 provider（ADR 决策 C）═══════════════════════════════════
   *
   * 两档的镜像不再是同一张：aio 档跑上游 AIO（自带 `:8080` 的 HTTP agent，13GB），
   * boxlite 档跑精简镜像（`node:22-slim` + tmux + CLI，1.25GB）。**它们不可互换**——
   * 拿 boxlite 那张去跑 aio，会在就绪门那步响亮超时（那张镜像里根本没有 agent）。
   *
   * ⚠️ **没有这个参数，两件事都会悄悄错**：
   *   ① 不给 selector 时挑的是「平台默认镜像」而不是「**这一档的**默认镜像」；
   *   ② 给了 selector 时，一张只在另一档能跑的镜像会被**照单全收**，然后在
   *      `provider.start()` 里超时——那时用户看到的是「启动实例卡住」，而不是
   *      「你选的镜像跟这一档不配」。
   *
   * ⚠️ **兼容性从血统推，不是从声明读。** 判据是「这张镜像派生自哪一张锚点」
   * （`derivedFromDigest`，注册期算好并落库），而锚点属于哪一档是**平台自己的配置**
   * （`SANDBOX_<PROVIDER>_IMAGE`）。选血统而不是显式声明的理由与 `platform.tmux` 那次
   * 搬家同源：**声明会被继承、会过期、会说谎**，而血统是注册期就验过的可验证事实，
   * 且已经算出来存着了——多一份手抄就多一处会不一致的地方。
   *
   * ⚠️ **单档部署下这条检查恒真**：两档指向同一张锚点，任何合规镜像都同时属于两档。
   * 也就是说它对今天绝大多数部署**不改变任何行为**，只在真的配了双档时才开始拦。
   *
   * @throws ImageAccessError when no such selectable image exists, or when the image
   *   cannot run on `provider`.
   */
  resolveForTask(selector: string | undefined, provider: string): Promise<TaskImageSelection>;

  /**
   * 时刻④ — provision reads the coordinate back by manifest id, so what reaches
   * `provider.create()` is `ref@digest` rather than a tag. Returns `null` for a
   * pre-image-slice sandbox row (its `image_ref` is NULL — see 13 §2.1 迁移).
   */
  findTaskImage(manifestId: string): Promise<TaskImageSelection | null>;

  /**
   * 诊断用（P21-5 §9A 第 4 步）：按**仓库坐标**查平台库里那一行，**不判断可不可选**。
   *
   * ⚠️ 返回 `null` 只表示「库里没有这张」，绝不表示「这张不能用」—— 停用的、invalid 的
   * 都照样返回，因为诊断要对这三种情况说三句不同的话。判定留给调用方，本方法只交事实。
   *
   * ⚠️ 仍然是一次**纯数据库读**（本文件顶部那条纪律没有例外）：registry 那一跳由诊断
   * 链的第 2 步显式做，两步分开才能分别报「registry 里没有」与「平台没注册」。
   */
  findRegisteredByRef(ref: string): Promise<RegisteredImageSummary | null>;
}

export const IMAGE_FACADE = Symbol('ImageFacade');
