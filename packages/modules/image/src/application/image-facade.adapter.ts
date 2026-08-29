import { Inject, Injectable, Logger } from '@nestjs/common';
import { builtinImageRefFor } from '@platform/shared-kernel';
import { ImageAccessError, formatImageRef, parseImageRef } from '@platform/contracts';
import type { ImageFacade, RegisteredImageSummary, TaskImageSelection } from '@platform/contracts';
import { IMAGE_REPOSITORY } from '../domain/repositories/image.repository';
import type { ImageRepository } from '../domain/repositories/image.repository';
import { IMAGE_MANIFEST_REPOSITORY } from '../domain/repositories/image-manifest.repository';
import type { ImageManifestRepository } from '../domain/repositories/image-manifest.repository';
import { ENV_SECRET_CIPHER } from '../domain/ports/env-secret.cipher.port';
import type { EnvSecretCipher } from '../domain/ports/env-secret.cipher.port';
import { EnvVarSet } from '../domain/value-objects/env-var-set.vo';
import { mergeEnv } from '../domain/services/env-merge.domain-service';
import type { ImageManifest } from '../domain/entities/image-manifest.entity';
import type { Image } from '../domain/entities/image.entity';

/**
 * Implements the cross-context `ImageFacade` so the `sandbox` context can enforce
 * I-IMG-2 / I-IMG-3 at the create door and pull by `ref@digest` at provision, WITHOUT
 * importing the image domain (26 §7 第 7 条).
 *
 * ⚠️ EVERY PATH HERE IS A DATABASE READ — there is no `resolve()` call anywhere in
 * this file, and that omission is the design. Adding one would put
 * `REGISTRY_UNREACHABLE` (502, retryable:true) inside a door whose whole contract is
 * 「原样再发一次必然同样被拒」 (04 §7 / 10 §6.8). The cost is that a re-pushed tag is
 * only discovered by an explicit re-validate — which is what we want: a coordinate
 * migration should be a visible action, not an unnoticed drift.
 */
@Injectable()
export class ImageFacadeAdapter implements ImageFacade {
  private readonly logger = new Logger('ImageFacade');

  constructor(
    @Inject(IMAGE_REPOSITORY) private readonly images: ImageRepository,
    @Inject(IMAGE_MANIFEST_REPOSITORY) private readonly manifests: ImageManifestRepository,
    @Inject(ENV_SECRET_CIPHER) private readonly cipher: EnvSecretCipher,
  ) {}

  async resolveForTask(
    selector: string | undefined,
    provider: string,
  ): Promise<TaskImageSelection> {
    // ⚠️ 记下**是谁选的**：没给 selector 时用的是平台默认镜像，而那两种情况下
    //    「下一步该做什么」完全不同——见文件末尾 `notRegisteredMessage()`。
    const usingPlatformDefault = (selector ?? '').trim() === '';
    // ⚠️ **按档取兜底那一张**（ADR 决策 C）：两档的预制镜像不再是同一张，
    // 「没给镜像」在 aio 档与 boxlite 档是两个不同的答案。单档部署下两者相同。
    const wanted = usingPlatformDefault ? builtinImageRefFor(provider) : (selector ?? '').trim();

    // ① A manifest id is the canonical selector — it is what `ImageManifestDto.id`
    //    carries and therefore what the wizard sends back.
    const byId = await this.manifests.findById(wanted);
    if (byId)
      return this.assertRunnable(
        await this.assertSelectable(byId, await this.imageOf(byId), wanted),
        byId,
        provider,
        wanted,
      );

    // ② A repository coordinate still resolves — the platform default is configured
    //    as one (`SANDBOX_DEFAULT_IMAGE`), and a human typing an image into an API
    //    client types a coordinate, not a uuid. It maps to the tag's CURRENT version,
    //    which is exactly what `is_active` means.
    const parsed = parseImageRef(wanted);
    const image = await this.images.findByName(parsed.name);
    if (image) {
      const reference = parsed.digest ?? parsed.tag ?? 'latest';
      const active = await this.manifests.findActiveByVersion(image.id, reference);
      if (active) {
        return this.assertRunnable(
          this.assertSelectable(active, image, wanted),
          active,
          provider,
          wanted,
        );
      }
      // The tag exists in history but has no live row: say so, rather than 「unknown
      // image」 — the user's fix is [启用] a version, not a different reference.
      const history = await this.manifests.listByImage(image.id);
      if (history.some((m) => m.version === reference)) {
        throw new ImageAccessError(
          'IMAGE_NOT_REGISTERED',
          `镜像 '${wanted}' 的所有版本都已停用，不能被新任务选用（I-IMG-3）；请先启用一个版本。`,
        );
      }
    }

    throw new ImageAccessError(
      'IMAGE_NOT_REGISTERED',
      notRegisteredMessage(wanted, usingPlatformDefault),
    );
  }

  /**
   * ★ 「**这张镜像跑得在这一档上吗**」—— ADR 决策 C 长出来的那个新概念。
   *
   * ── 判据：从**血统**推，不从**声明**读 ────────────────────────────────────
   * 一张用户镜像属于哪一档，由「它派生自哪一张锚点」决定；而锚点属于哪一档，是
   * **平台自己的配置**（`SANDBOX_<PROVIDER>_IMAGE`），不是镜像上的任何一句话。
   *
   * ⚠️ **为什么不让镜像自己声明**（比如一个 `platform.providers` 标签）：那正是
   * `platform.tmux` 那次搬家的教训——标签会被派生镜像**继承**、会**过期**、而且**防不住
   * 谎报**。血统是注册期就验过的**可验证事实**（`diff_ids` 前缀），而且已经算出来落库了
   * （`derivedFromDigest`）。多一份手抄，就多一处迟早会不一致的地方。
   *
   * ── 比的是「同一个**仓库**」，不是「同一个 digest」 ─────────────────────────
   * ⚠️ 这一条是本方法唯一容易写错的地方。预制镜像会升级：`platform/sandbox:v2` 通常就是
   * `:v1` 再叠一层，两张**都是** builtin 锚点。如果拿「当前配置那一张的 digest」去比，
   * 那么运维方把 `SANDBOX_AIO_IMAGE` 从 v1 换到 v2 的那一刻，**所有基于 v1 的用户镜像会
   * 集体变成「跑不了」** —— 而它们什么都没变，也确实还能跑。
   * ⇒ 比的是锚点所属的那一**行 `images`**（同一个仓库名的所有版本），这正是
   *   `images` 表本来就在建模的东西。
   *
   * ── 拿不准时**放行**，不拦 ──────────────────────────────────────────────
   * ⚠️ 这一档的锚点还没播种成功（离线部署、registry 限流）时，本方法**无法证明**
   * 不兼容，于是不拦。少报是降级（用户可能撞上一个启动超时），多报是撒谎（把一张本来
   * 能跑的镜像拦下来，而用户没有任何办法自证）。真正的「一张预制镜像都没有」由
   * `notRegisteredMessage` 那条路负责说。
   *
   * ⚠️ **单档部署下本方法恒为放行**：两档指向同一张锚点，任何合规镜像都同时属于两档。
   */
  private async assertRunnable(
    selection: TaskImageSelection,
    manifest: ImageManifest,
    provider: string,
    wanted: string,
  ): Promise<TaskImageSelection> {
    const anchorRef = builtinImageRefFor(provider);
    const anchorImage = await this.images.findByName(parseImageRef(anchorRef).name);
    if (anchorImage === null) return selection; // 证明不了不兼容 ⇒ 不拦（见注释）
    if (manifest.imageId === anchorImage.id) return selection; // 就是这一档的锚点本身
    const anchorDigests = new Set(
      (await this.manifests.listByImage(anchorImage.id)).map((m) => m.digest),
    );
    if (manifest.derivedFromDigest !== null && anchorDigests.has(manifest.derivedFromDigest)) {
      return selection;
    }
    throw new ImageAccessError(
      'IMAGE_PROVIDER_MISMATCH',
      `镜像 '${wanted}' 跑不在 '${provider}' 档上：它不是从这一档的预制镜像 ` +
        `'${anchorRef}' 派生出来的。两档的预制镜像不是同一张（aio 档跑自带沙箱内 HTTP ` +
        'API 的 AIO 镜像，boxlite 档跑精简镜像），拿错那张会在「启动实例」处超时。' +
        `下一步：换成 '${provider}' 档的镜像，或者把任务建在这张镜像所属的那一档上。`,
    );
  }

  /**
   * 诊断第 ⑧ 项第 4 步（P21-5 §9A）。**交事实，不下判断。**
   *
   * ⚠️ 刻意**不复用 `resolveForTask`**：那条路把「没注册 / 全停用 / invalid」三种情况
   * 都收敛成一个 `IMAGE_NOT_REGISTERED`（门口只需要知道「不能用」），而诊断存在的理由
   * 正是把它们分开说 —— 三者的下一步分别是「重启平台等播种」「去启用一个版本」
   * 「换一张镜像」。
   *
   * ⚠️ 按 tag 查的是**当前启用的那一版**（`findActiveByVersion`）；没有启用版本时退回
   * 历史行，这样「有这张、但全停用了」不会被误报成「压根没有这张」。
   */
  async findRegisteredByRef(ref: string): Promise<RegisteredImageSummary | null> {
    const parsed = parseImageRef(ref.trim());
    const image = await this.images.findByName(parsed.name);
    if (!image) return null;
    const reference = parsed.digest ?? parsed.tag ?? 'latest';
    const active = await this.manifests.findActiveByVersion(image.id, reference);
    const manifest =
      active ??
      (await this.manifests.listByImage(image.id)).find((m) => m.version === reference) ??
      null;
    if (!manifest) return null;
    return {
      manifestId: manifest.id,
      ref: formatImageRef(image.name, manifest.version),
      digest: manifest.digest,
      validationStatus: manifest.validation.status,
      isActive: manifest.isActive,
      isBuiltin: image.isBuiltin,
      entrypoint: manifest.entrypointContract.entrypoint,
    };
  }

  async findTaskImage(manifestId: string): Promise<TaskImageSelection | null> {
    const manifest = await this.manifests.findById(manifestId);
    if (!manifest) return null;
    const image = await this.images.findById(manifest.imageId);
    if (!image) return null;
    return { ...this.toSelection(manifest, image), env: this.envOf(manifest) };
  }

  /**
   * The image layer of the three-layer merge (23 §9.5, 05 §4.1).
   *
   * ⚠️ THE OTHER TWO LAYERS ARE EMPTY BECAUSE THEY DO NOT EXIST YET — there is no
   * project-level or task-level env table (v1.1). Going through `mergeEnv` anyway is
   * not ceremony: it means the day those layers land, the ONE place that decides
   * precedence is already the place that decides it, instead of a `{...image}` spread
   * here that someone has to notice and replace.
   *
   * ⚠️ AND SECRETS ARE DECRYPTED HERE, AT THE LAST POSSIBLE MOMENT. A value that
   * cannot be decrypted (rotated key) is DROPPED with a warning rather than injected
   * as ciphertext — a container that receives a base64 blob where a token belongs
   * fails in a way nobody can read.
   */
  private envOf(manifest: ImageManifest): Record<string, string> {
    const entries = (manifest.config?.env ?? []).flatMap((e) => {
      if (!e.secret) return [{ key: e.key, value: e.value ?? '' }];
      if (!e.valueEncrypted) return [];
      try {
        return [{ key: e.key, value: this.cipher.open(e.valueEncrypted) }];
      } catch {
        this.logger.warn(
          `image ${manifest.id}: secret env '${e.key}' could not be decrypted (rotated master key?) — it is NOT injected`,
        );
        return [];
      }
    });
    const merged = mergeEnv(EnvVarSet.create(entries), EnvVarSet.empty(), EnvVarSet.empty());
    return Object.fromEntries(merged.map((m) => [m.key, m.value]));
  }

  /**
   * I-IMG-2 + I-IMG-3, the two door invariants (04 §7 时刻③).
   *
   * ⚠️ THEY ARE CHECKED ON THE ROW, NOT ON THE LIST QUERY. `listSelectable` already
   * filters, and relying on that alone means the invariant holds only for users who
   * came through the dropdown — an API client posting a remembered id would walk
   * straight past it. The door is where 「不可选」 has to mean something.
   */
  private assertSelectable(
    manifest: ImageManifest,
    image: Image,
    selector: string,
  ): TaskImageSelection {
    if (!manifest.isActive) {
      throw new ImageAccessError(
        'INVALID_IMAGE_REFERENCE',
        `镜像版本 '${selector}' 已停用，不能被新任务选用（I-IMG-3）；已有任务的引用不受影响。`,
      );
    }
    if (manifest.validation.status === 'invalid') {
      throw new ImageAccessError(
        'INVALID_IMAGE_REFERENCE',
        `镜像版本 '${selector}' 的校验结论是 invalid，不能被新任务引用（I-IMG-2）。`,
      );
    }
    return this.toSelection(manifest, image);
  }

  private toSelection(manifest: ImageManifest, image: Image): TaskImageSelection {
    return {
      manifestId: manifest.id,
      ref: formatImageRef(image.name, manifest.version),
      digest: manifest.digest,
      entrypoint: manifest.entrypointContract.entrypoint,
      manifest: {
        name: image.name,
        version: manifest.version,
        baseImage: manifest.baseImage,
        entrypointContract: manifest.entrypointContract,
        supportedRuntimes: manifest.supportedRuntimes,
        resourceDefaults: manifest.resourceDefaults,
        labelsRequired: manifest.labelsRequired,
        diffIds: manifest.diffIds,
      },
      resolvedAt: manifest.registeredAt.toISOString(),
    };
  }

  private async imageOf(manifest: ImageManifest): Promise<Image> {
    const image = await this.images.findById(manifest.imageId);
    if (!image) {
      throw new ImageAccessError(
        'INVALID_IMAGE_REFERENCE',
        `manifest ${manifest.id} has no parent image row`,
      );
    }
    return image;
  }
}

/**
 * 「这张镜像没注册」在**两种**情况下说的不是同一件事，下一步也完全不同。
 *
 * ⚠️ 这个区分是补上去的，因为缺了它的时候平台会**把用户送去做一件必然失败的事**：
 * 全新部署里没人选镜像 ⇒ 走平台默认 ⇒ 没播种成功 ⇒ 向导弹出
 * 「镜像 'ghcr.io/agent-infra/sandbox:latest' 尚未注册，请先在镜像管理里注册它」。
 * 用户照做，注册会被血统检查拒（上游镜像不是平台预制镜像，没有 `platform.tmux`）——
 * 他做了消息叫他做的事，失败了，还会以为是自己做错了。
 *
 * ⚠️ 而**开机日志早就说对了**（`ImageSeeder` 纪律②：真正的下一步是把预制镜像那一张
 * 修好）。同一件事两条提示、指向两个不同的下一步，且用户看得见的那条是错的——
 * 「说错下一步比不打日志更贵」在这里是字面意义上的。
 *
 * 用户**自己选**的镜像没注册时，原来那句仍然对：去镜像管理注册它就行。
 */
function notRegisteredMessage(wanted: string, usingPlatformDefault: boolean): string {
  if (!usingPlatformDefault) {
    return (
      `镜像 '${wanted}' 尚未注册。请先在镜像管理里注册它（POST /api/images），` +
      '平台只运行注册过、已解析出 digest 的镜像。'
    );
  }
  return (
    `平台还没有可用的预制镜像：当前 SANDBOX_DEFAULT_IMAGE 指向 '${wanted}'，而它没有注册进来。` +
    '⚠️ 这**不是**「把这一张注册进来」能解决的——预制镜像必须是平台自己构建的那一张' +
    '（构建脚本在 api/images/platform-sandbox），上游镜像只是它的 FROM，注册时会被血统检查拒。' +
    '把构建好的镜像推到 registry、让 SANDBOX_DEFAULT_IMAGE 指过去，平台开机会自动播种。'
  );
}
