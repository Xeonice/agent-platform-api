import { Inject, Injectable } from '@nestjs/common';
import {
  CLOCK,
  EVENT_BUS,
  ID_GENERATOR,
  UNIT_OF_WORK,
  type Clock,
  type EventBus,
  type IdGenerator,
  type UnitOfWork,
} from '@platform/shared-kernel';
import {
  IMAGE_BASE_REQUIRED,
  IMAGE_LABEL_TMUX,
  IMAGE_SPEC_REGISTRY,
  IMAGE_TMUX_MISSING,
  ImageSpecError,
  REF_NOT_FOUND,
  formatImageRef,
  isDerivedFrom,
  isOciDigest,
  parseImageRef,
} from '@platform/contracts';
import type {
  CheckImageUpdateDto,
  ImageConfigInput,
  ImageManifestDto,
  ImageSpecRegistry,
  PatchImageInput,
  ResolvedImage,
  RevalidateOutcomeDto,
  ValidationIssue,
  ValidationOutcomeDto,
} from '@platform/contracts';
import { Image } from '../domain/entities/image.entity';
import { ImageManifest } from '../domain/entities/image-manifest.entity';
import type { ImageConfigVO, StoredEnvEntry } from '../domain/entities/image-manifest.entity';
import { EnvVarSet } from '../domain/value-objects/env-var-set.vo';
import { ValidationOutcome } from '../domain/value-objects/validation-outcome.vo';
import { ImageNotDeletableError, ImageStateError } from '../domain/errors/image-errors';
import { IMAGE_REPOSITORY } from '../domain/repositories/image.repository';
import type { ImageRepository } from '../domain/repositories/image.repository';
import { IMAGE_MANIFEST_REPOSITORY } from '../domain/repositories/image-manifest.repository';
import type { ImageManifestRepository } from '../domain/repositories/image-manifest.repository';
import { ENV_SECRET_CIPHER } from '../domain/ports/env-secret.cipher.port';
import type { EnvSecretCipher } from '../domain/ports/env-secret.cipher.port';
import { ImageMapper } from './dto/image.mapper';

/** `POST /api/images` answers 200 for a re-registration and 201 for a new row (27 §6). */
export interface RegisterImageResult {
  manifest: ImageManifestDto;
  validation: ValidationOutcomeDto;
  /** `true` ⇒ a row was INSERTed ⇒ 201; `false` ⇒ the digest was already known ⇒ 200. */
  created: boolean;
}

/** Raised when `PATCH` is asked to enable a version (10 §6 ★). Mapped to 400. */
export class PatchCannotActivateError extends Error {
  constructor(readonly manifestId: string) {
    super(
      `启用某个版本会同时停用同一 tag 的现任版本，是「换」而不是「改」——` +
        `请改用 POST /api/images/${manifestId}/activate。`,
    );
    this.name = 'PatchCannotActivateError';
  }
}

/** Raised when a delete would orphan a live Task's image, or targets a built-in. */
export class ImageDeleteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageDeleteRefusedError';
  }
}

/** Raised when a manifest id does not exist. Mapped to 404 `NOT_FOUND`. */
export class ImageNotFoundError extends Error {
  constructor(id: string) {
    super(`image manifest ${id} not found`);
    this.name = 'ImageNotFoundError';
  }
}

/**
 * Protocol-agnostic application service for the image context (02 §1, 24 §7).
 *
 * ⚠️ THE NETWORK LIVES IN EXACTLY TWO OF THESE METHODS — `registerImage` and
 * `revalidateImage` (plus the read-only `validateImage` / `checkImageUpdate` probes,
 * which persist nothing). Everything the CREATE DOOR needs is served from the
 * database by `ImageFacadeAdapter`. That split is the whole reason the door can keep
 * promising 「every rejection here is `retryable:false` and side-effect free」
 * (04 §7 / 10 §6.8).
 *
 * ⚠️ `resolve` AND `validate` RUN OUTSIDE THE TRANSACTION. `resolve` is IO, and
 * `validate` is a pure judgement (testkit IS-04) that may therefore be re-run freely.
 * A manifest judged `invalid` is NOT stored at all — no 「invalid 半成品记录」 for the
 * user to clean up before retrying (24 §7.2).
 */
@Injectable()
export class ImageApplicationService {
  constructor(
    @Inject(IMAGE_REPOSITORY) private readonly images: ImageRepository,
    @Inject(IMAGE_MANIFEST_REPOSITORY) private readonly manifests: ImageManifestRepository,
    @Inject(IMAGE_SPEC_REGISTRY) private readonly specs: ImageSpecRegistry,
    @Inject(ENV_SECRET_CIPHER) private readonly cipher: EnvSecretCipher,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /**
   * `GET /api/images` — `?runtimeId=` asks for the wizard's SELECTABLE set.
   *
   * ⚠️ `runtimeId` IS NOW A PRESENCE SWITCH, NOT A FILTER, AND THE ENDPOINT STILL
   * NEEDS IT. Present ⇒ the selectable set (`is_active` ∧ not `invalid`); absent ⇒ the
   * management page's full history. What it no longer does is narrow BY runtime: an
   * image is not hidden from a runtime it merely has not preinstalled — lineage
   * guarantees it can install one (see `listSelectable`). The parameter is kept
   * because the two questions are genuinely different, and because the wizard already
   * sends the runtime it is configuring.
   */
  async listImages(runtimeId?: string): Promise<ImageManifestDto[]> {
    const manifests =
      runtimeId === undefined
        ? await this.manifests.listAll()
        : await this.manifests.listSelectable();
    const images = new Map((await this.images.list()).map((i) => [i.id, i]));
    return manifests.flatMap((m) => {
      const image = images.get(m.imageId);
      return image ? [ImageMapper.toDto(m, image)] : [];
    });
  }

  /**
   * `POST /api/images` — 04 §7 时刻①, the ONE place a tag becomes a digest.
   *
   * ⚠️ IDEMPOTENT ON `(image_id, digest)`, AND IT DELIBERATELY DOES NOT 409. Pasting
   * the same URI again almost always means 「refresh this」; answering 409 sends the
   * user to delete-and-recreate, and the delete is blocked by RESTRICT the moment any
   * Task ever used the image (P21-4 §6).
   *
   * ⚠️ A RE-PUSHED TAG INSERTS A SECOND ROW; IT NEVER EDITS THE FIRST (I-IMG-7). The
   * new row is active only if the tag currently has no live version — otherwise it
   * waits for an explicit `activate`, because swapping which bits every future Task
   * runs is not something a re-paste should do behind the user's back.
   */
  async registerImage(ref: string, opts: { builtin?: boolean } = {}): Promise<RegisterImageResult> {
    const resolved = await this.resolveAndJudge(ref);
    const parsed = parseImageRef(resolved.ref);
    const now = this.clock.now();

    const existingImage = await this.images.findByName(parsed.name);
    const image =
      existingImage ??
      Image.create({
        id: this.ids.next(),
        name: parsed.name,
        ownerRef: null,
        // ⚠️ 只有**启动播种**会传 true（`ImageSeeder`）；REST 注册永远是 false。
        // `isBuiltin` 的唯一效果是 I-IMG-4「预置镜像不可删除，只可禁用」——
        // 让用户误删平台自带的那张，等于让平台从此建不出 Task。
        isBuiltin: opts.builtin === true,
        createdAt: now,
      });

    const known = existingImage
      ? await this.manifests.findByDigest(image.id, resolved.digest)
      : null;
    if (known) {
      return {
        manifest: ImageMapper.toDto(known, image),
        validation: ImageMapper.outcome(resolved.outcome),
        created: false,
      };
    }

    // ⚠️ ADMISSION IS CHECKED ONLY ON THE PATH THAT INSERTS. A digest already in the
    // catalogue entered it through this same gate; re-judging it would let a change
    // elsewhere (a retired base, a wiped seed) turn a completed registration into a
    // failure the user cannot act on. The gate is where a row is BORN.
    //
    // ⚠️ AND THE GATE IS WHERE THE ANSWER IS AVAILABLE. It has just walked every
    // anchor and knows WHICH one this image descends from; that fact is only true of
    // this instant, so it is written down with the row rather than recomputed later
    // against a catalogue that may have changed underneath it.
    const derivedFromDigest = await this.assertAdmissible(resolved, opts.builtin === true);

    const version = resolved.manifest.version;
    const tagHasLiveRow =
      existingImage !== null &&
      (await this.manifests.findActiveByVersion(image.id, version)) !== null;

    // ⚠️ 事件带的是**完整坐标**（`platform/sandbox:v2`），不是 `version` 那一段。
    // 审计的 summary 要写出用户认得的串（13 §2.8.2）—— 孤零零一个 `v2` 认不出是哪张。
    const manifestRef = formatImageRef(image.name, version);
    const manifest = ImageManifest.create(
      {
        id: this.ids.next(),
        imageId: image.id,
        version,
        baseImage: resolved.manifest.baseImage,
        digest: resolved.digest,
        entrypointContract: resolved.manifest.entrypointContract,
        supportedRuntimes: resolved.manifest.supportedRuntimes,
        resourceDefaults: resolved.manifest.resourceDefaults,
        labelsRequired: resolved.manifest.labelsRequired ?? [],
        diffIds: resolved.manifest.diffIds,
        derivedFromDigest,
        validation: resolved.outcome,
        config: null,
        isActive: !tagHasLiveRow,
        registeredAt: now,
      },
      manifestRef,
    );

    this.uow.run((tx) => {
      this.images.saveSync(tx, image);
      this.manifests.saveSync(tx, manifest);
      this.events.publishInTx(tx, [...image.pullEvents(), ...manifest.pullEvents()]);
    });

    return {
      manifest: ImageMapper.toDto(manifest, image),
      validation: ImageMapper.outcome(resolved.outcome),
      created: true,
    };
  }

  /**
   * `POST /api/images/validate` — pre-flight. Resolves, judges, stores NOTHING.
   *
   * ⚠️ IT RUNS THE LINEAGE CHECK TOO, AND IT HAS TO. This is the wizard's 「提交 URI →
   * 三级反馈」 step; if it answered ✅ and the next click answered 422
   * `IMAGE_BASE_REQUIRED`, the two halves would each be internally correct and the pair
   * would be a lie — the same shape as every 「两侧各自完整、合起来漏一条」 defect this
   * repo keeps paying for. The pre-flight always judges as a USER image (there is no
   * 「注册成根镜像」 button), which is why it takes no `builtin` flag.
   */
  async validateImage(ref: string): Promise<ValidationOutcomeDto> {
    const spec = this.specs.get(this.specs.defaultProvider);
    const resolved = await spec.resolve(ref);
    const result = spec.validate(resolved.manifest);
    const { finding } = await this.lineageVerdict(resolved);
    const errors = finding === null ? result.errors : [...result.errors, finding];
    return ImageMapper.outcome(ValidationOutcome.from(errors, result.warnings ?? []));
  }

  /**
   * `POST /api/images/:id/validate` — 04 §7 时刻②, the ONLY moment a re-pushed tag is
   * discovered.
   *
   * ⚠️ WHEN THE DIGEST MOVED, THE NEW VERDICT IS **NOT** WRITTEN BACK. The re-resolved
   * manifest describes DIFFERENT BITS; stamping its status onto this row would make
   * the row claim something about bits it does not contain, and `digest` cannot be
   * updated to match (I-IMG-7). So the response reports the migration 旧 → 新 and the
   * row keeps its own verdict — 「不能当成一次刷新成功悄悄写回」 is exactly this.
   * The user's next step is `POST /api/images` (INSERT the new row) then `activate`.
   */
  async revalidateImage(id: string): Promise<RevalidateOutcomeDto> {
    const manifest = await this.mustFindManifest(id);
    const image = await this.mustFindImage(manifest.imageId);
    const spec = this.specs.get(this.specs.defaultProvider);
    const ref = formatImageRef(image.name, manifest.version);
    const resolved = await spec.resolve(ref);
    const result = spec.validate(resolved.manifest);
    const outcome = ValidationOutcome.from(result.errors, result.warnings ?? []);
    const digestChanged = resolved.digest !== manifest.digest;

    if (!digestChanged) {
      manifest.recordValidation(outcome, ref, this.clock.now());
      this.uow.run((tx) => {
        this.manifests.saveSync(tx, manifest);
        this.events.publishInTx(tx, manifest.pullEvents());
      });
    }

    return {
      ...ImageMapper.outcome(outcome),
      currentDigest: manifest.digest,
      upstreamDigest: resolved.digest,
      digestChanged,
    };
  }

  /** `PATCH /api/images/:id` — the only entry point for the two mutable fields. */
  async patchImage(id: string, patch: PatchImageInput): Promise<ImageManifestDto> {
    const manifest = await this.mustFindManifest(id);
    const image = await this.mustFindImage(manifest.imageId);
    const now = this.clock.now();

    const ref = formatImageRef(image.name, manifest.version);

    if (patch.isActive === true) throw new PatchCannotActivateError(id);
    if (patch.isActive === false) manifest.deactivate(ref, now);
    if (patch.imageConfig !== undefined) {
      manifest.updateConfig(this.sealConfig(patch.imageConfig, manifest.config), ref, now);
    }

    this.uow.run((tx) => {
      this.manifests.saveSync(tx, manifest);
      this.events.publishInTx(tx, manifest.pullEvents());
    });
    return ImageMapper.toDto(manifest, image);
  }

  /**
   * `POST /api/images/:id/activate` — make this row the tag's current version.
   *
   * ⚠️ ONE ENDPOINT FOR BOTH 「更新到新版本」 AND 「回滚到旧版本」, because they are
   * the same operation in opposite directions: move the pointer. Two endpoints would
   * make rollback look like an exception path, and rollback (upstream pushed a bad
   * build) is an ordinary thing to need.
   *
   * ⚠️ BOTH WRITES ARE IN ONE TRANSACTION. `unique(image_id, version) WHERE is_active`
   * means there is an instant where two rows are active; only a transaction makes it
   * unobservable, and doing it in two steps either wedges on the index or leaves the
   * tag with no current version at all (I-IMG-8).
   */
  async activateImage(id: string): Promise<ImageManifestDto> {
    const manifest = await this.mustFindManifest(id);
    const image = await this.mustFindImage(manifest.imageId);
    manifest.activate(formatImageRef(image.name, manifest.version), this.clock.now());
    this.uow.run((tx) => {
      this.manifests.deactivateOthersSync(tx, manifest.imageId, manifest.version, manifest.id);
      this.manifests.saveSync(tx, manifest);
      this.events.publishInTx(tx, manifest.pullEvents());
    });
    return ImageMapper.toDto(manifest, image);
  }

  /** `POST /api/images/:id/check-update` — read-only drift probe; stores nothing. */
  async checkImageUpdate(id: string): Promise<CheckImageUpdateDto> {
    const manifest = await this.mustFindManifest(id);
    const image = await this.mustFindImage(manifest.imageId);
    const current = { digest: manifest.digest, resolvedAt: manifest.registeredAt.toISOString() };

    // A row registered BY DIGEST has no tag to re-resolve — it cannot drift by
    // construction, so 「check for updates」 is not a failure here, it is a category
    // error (27 §6 → INVALID_STATE 409).
    if (isOciDigest(manifest.version)) {
      throw new ImageStateError(
        `manifest ${id} is pinned by digest, so there is no tag to re-resolve; ` +
          'a digest-pinned image cannot drift.',
      );
    }

    const spec = this.specs.get(this.specs.defaultProvider);
    try {
      const resolved = await spec.resolve(formatImageRef(image.name, manifest.version));
      const result = spec.validate(resolved.manifest);
      return {
        current,
        upstream: {
          digest: resolved.digest,
          validation: ImageMapper.outcome(
            ValidationOutcome.from(result.errors, result.warnings ?? []),
          ),
        },
        changed: resolved.digest !== manifest.digest,
      };
    } catch (e) {
      // The TAG is gone upstream. That is information, not a failure: the pinned
      // digest keeps pulling, so nothing is broken — there is simply nothing to
      // update to. This is the case the contract's `upstream: … | null` is for.
      if (e instanceof ImageSpecError && e.code === REF_NOT_FOUND) {
        return { current, upstream: null, changed: false };
      }
      throw e;
    }
  }

  /** `DELETE /api/images/:id` — hard delete of ONE manifest row. */
  async deleteImage(id: string): Promise<void> {
    const manifest = await this.mustFindManifest(id);
    const image = await this.mustFindImage(manifest.imageId);
    try {
      // The rule lives on the aggregate (I-IMG-4), not here: an `isBuiltin` check
      // written inline is a second place that has to remember it.
      image.assertDeletable();
    } catch (e) {
      if (e instanceof ImageNotDeletableError) throw new ImageDeleteRefusedError(e.message);
      throw e;
    }
    const referencing = await this.manifests.countReferencingSandboxes(id);
    if (referencing > 0) {
      throw new ImageDeleteRefusedError(
        `还有 ${String(referencing)} 个 Task 在使用这个版本，删除会让它们的镜像坐标悬空；` +
          '请改为禁用（PATCH { isActive: false }）。',
      );
    }
    const siblings = await this.manifests.listByImage(image.id);
    // ⚠️ 事件在删行**之前**攒好、与删行**同一个事务** publish：删掉之后 `ref` 没有任何
    // 库可以回查（13 §2.8.2「审计必须在主体被删除之后继续存在」）。
    manifest.markDeleted(formatImageRef(image.name, manifest.version), this.clock.now());
    this.uow.run((tx) => {
      this.manifests.deleteSync(tx, id);
      // A name with no versions left is not an image any more — leaving the row would
      // make `images` accumulate entries the UI can only render as empty cards.
      if (siblings.length <= 1) this.images.deleteSync(tx, image.id);
      this.events.publishInTx(tx, manifest.pullEvents());
    });
  }

  /**
   * ★ 平台准入：注册期判定的第二层，与 `ImageSpecProvider.validate()` 分工明确。
   *
   * ── 为什么它在 application 层，而不在 `validate()` 里 ────────────────────────
   * ① `validate(manifest)` 契约上是**纯判断**（testkit IS-04：不修改入参、无 IO、可
   *    随时重跑）。血统校验必须知道「平台注册过哪些 base」——那是**库里的状态**，塞进
   *    去就破了 IS-04，而 IS-04 正是「结论可以脱离事务重算」的依据。
   * ② **血统是平台策略，不是镜像规格。** `ImageSpecProvider` 是可被第三方替换的 SPI
   *    （`registry-extension.e2e` 真的换过一个）；把平台自己的准入策略塞进 SPI，等于
   *    要求每个第三方实现替我们执行我们的策略——它们既没有义务，也没有那份库状态。
   *
   * ── 三层判定，各管一段，谁也不假装知道自己不知道的事（04 §7 ★血统）──────────
   * | 事实 | 怎么知道 | 谁来判 |
   * |---|---|---|
   * | 是否基于平台预制镜像 | `diff_ids` 前缀 | **注册期，可验证** ← 本方法 |
   * | 预制镜像有 tmux/bash/node | 平台自己构建的 | 平台自己保证 |
   * | 派生镜像没删掉 tmux | 元数据看不出来 | **运行期实测** `command -v tmux` |
   * | 预装了哪些 runtime CLI | 标签（可继承、可能过期） | 只驱动 warning，不阻断 |
   */
  private async assertAdmissible(
    resolved: ResolvedImage,
    builtin: boolean,
  ): Promise<string | null> {
    if (builtin) {
      this.assertRootDeclaresTmux(resolved);
      // ⚠️ A ROOT'S LINEAGE IS `null`, AND THAT IS THE FACT, NOT A MISSING VALUE. It
      // is exempt from the check precisely because it HAS no platform ancestor —
      // pointing it at itself would invent a self-loop nothing asked for.
      return null;
    }
    const { finding, derivedFromDigest } = await this.lineageVerdict(resolved);
    if (finding !== null) {
      throw new ManifestInvalidError(ValidationOutcome.from([finding], []));
    }
    return derivedFromDigest;
  }

  /**
   * 根镜像（`SANDBOX_DEFAULT_IMAGE`，由 `ImageSeeder` 以 `builtin: true` 注册）的规则。
   *
   * ⚠️ **它豁免血统校验，因为它就是锚点** —— 没有更早的祖先可比。取而代之的是一条
   * 弱得多、但目标不同的检查：这张镜像**声明**了 `platform.tmux` 吗？
   *
   * ⚠️ **这条防的是「指错了镜像」，不是「谎报」** —— 两者的区别必须写在明处，否则下一个
   * 人会以为根镜像的合规性已经有人担保了。它是**运维方对自己指定的那张镜像做的一次
   * 声明**：`SANDBOX_DEFAULT_IMAGE` 被填成一张随便的 `alpine:3.20` 时，开机就响亮地
   * 拒绝，而不是等到第一个 Task 起 tmux 会话时才炸。防谎报永远是运行期那次
   * `command -v tmux`（⇒ `IMAGE_CONTRACT_VIOLATION`），本条替代不了它。
   */
  private assertRootDeclaresTmux(resolved: ResolvedImage): void {
    if ((resolved.manifest.labelsRequired ?? []).includes(IMAGE_LABEL_TMUX)) return;
    throw new ManifestInvalidError(
      ValidationOutcome.from(
        [
          {
            code: IMAGE_TMUX_MISSING,
            path: `labels.${IMAGE_LABEL_TMUX}`,
            message:
              `平台根镜像 '${resolved.ref}' 未声明 ${IMAGE_LABEL_TMUX}=true。` +
              'agent 会话由沙箱内的 tmux 持有，根镜像是所有自定义镜像的血统起点；' +
              '请把 SANDBOX_DEFAULT_IMAGE 指向平台预制镜像（构建脚本在 api/images/platform-sandbox），' +
              '或给这张镜像补上该标签后重启。',
          },
        ],
        [],
      ),
    );
  }

  /**
   * 派生镜像的血统校验：`diff_ids` 必须是**某个已注册 builtin manifest 的 `diff_ids`
   * 的前缀扩展**（含相等）。满足 ⇒ 带出**匹配到的那张锚点的 digest**；不满足 ⇒ 一条
   * `IMAGE_BASE_REQUIRED`，`derivedFromDigest` 为 `null`。
   *
   * ⚠️ **它返回「是哪一张」，而不只是「过不过」，因为这两件事本来就是同一次比对算出来的。**
   * 旧版逐个比对、知道匹配上了哪一个，然后只把布尔结论带走——于是平台没有任何办法回答
   * 「谁基于谁」：卡片说不出「基于 X」，换 base 之后也提不出哪些客户镜像过期了。把答案
   * 留在函数里的代价，是它在别处只能靠再比一遍来复原，而两次比对迟早会不一致。
   *
   * ⚠️ **多个锚点都匹配时取最长前缀的那一个。这不是并列情况里随便挑一个。**
   * `platform/base` 与 `platform/sandbox` 是祖孙关系（后者 `FROM` 前者），于是一张
   * `FROM platform/sandbox` 的用户镜像**同时**是两者的后代，两条前缀都成立。最长的那个
   * 前缀是**最近的祖先**，也就是用户真的写在 Dockerfile 第一行的那张；取到祖父那张，
   * 「基于 X」就会显示成一个用户从没写过的坐标，而将来据此做自动 rebase 会把镜像 rebase
   * 到错误的 base 上。并列（长度相同）意味着两张锚点的层列表一字不差，取哪张都指向同一
   * 份 bits，这里保留先出现的那张（`listBuiltinAnchors` 按注册时间倒序，即最新的一张）。
   *
   * ⚠️ **为什么是 `diff_ids` 而不是 manifest digest**：manifest digest 是**压缩后** blob
   * 的哈希，用户把 base 镜像 mirror 到内网 registry 重新压一遍，digest 就变了而内容没变；
   * `diff_ids` 是**解压后**内容的哈希，跨 mirror 不变。用 digest 当锚点的规则只在构建它
   * 的那台机器上成立。
   *
   * ⚠️ **相等也算派生**：`LABEL` / `ENV` / `CMD` 不产生新层，所以一张老老实实
   * `FROM base` 只加标签的镜像，`diff_ids` 与 base **完全相同**（实测）。要求「严格更长」
   * 会把最正当的一种派生判成非法。
   *
   * ⚠️ **鸡生蛋：库里一个 builtin 都没有时拒绝，且拒的码不一样。** 播种失败（离线部署、
   * registry 限流）会让平台没有任何基准可比。此时**不能静默放行**——放行等于这条约束
   * 根本不存在，而它会在没人注意的时候永久失效。但也**不能报 `IMAGE_BASE_REQUIRED`**：
   * 那句话是在说「你的镜像不对」，而事实是**平台没准备好**；把用户支去改 Dockerfile 是
   * 让他修一个没坏的东西。所以走 `ImageStateError` ⇒ `INVALID_STATE`(409)，C 类
   * 「请求没错但此刻不行」，并说清什么时候可以（10 §6.8「C 要多说一句」）。
   */
  private async lineageVerdict(resolved: ResolvedImage): Promise<LineageVerdict> {
    const anchors = (await this.manifests.listBuiltinAnchors()).filter((a) => a.diffIds.length > 0);
    if (anchors.length === 0) {
      throw new ImageStateError(
        '平台还没有可用的预制镜像作为血统基准，暂时无法注册自定义镜像。' +
          '自定义镜像必须基于平台预制镜像，而平台需要先有一张预制镜像才能做这个比对——' +
          '通常是开机播种失败（离线部署 / registry 不可达）。' +
          '请先让 SANDBOX_DEFAULT_IMAGE 指向的预制镜像注册成功，再回来注册这一张。',
      );
    }

    // ⚠️ ONE PASS, ONE `isDerivedFrom` PER ANCHOR — the match and the identity of the
    // match are the SAME question, and asking it twice (once for 「过不过」, once for
    // 「是哪一张」) is how the two answers start disagreeing.
    const match = anchors.reduce<LineageAnchor | null>(
      (best, a) =>
        isDerivedFrom(resolved.manifest.diffIds, a.diffIds) &&
        (best === null || a.diffIds.length > best.diffIds.length)
          ? a
          : best,
      null,
    );
    if (match !== null) return { finding: null, derivedFromDigest: match.digest };

    return {
      finding: {
        code: IMAGE_BASE_REQUIRED,
        path: 'rootfs.diff_ids',
        message:
          `镜像 '${resolved.ref}' 不是基于平台预制镜像构建的。` +
          `请把 Dockerfile 改成 \`FROM ${anchors[0].ref}\`（或它的派生）重新构建后再注册——` +
          '平台按镜像层（rootfs.diff_ids）验证血统，改标签没有用。' +
          (anchors.length > 1
            ? `可用的预制镜像还有：${anchors
                .slice(1)
                .map((a) => a.ref)
                .join('、')}。`
            : ''),
      },
      derivedFromDigest: null,
    };
  }

  /** resolve + validate + refuse-if-invalid, shared by register and its callers. */
  private async resolveAndJudge(
    ref: string,
  ): Promise<ResolvedImage & { outcome: ValidationOutcome }> {
    const spec = this.specs.get(this.specs.defaultProvider);
    const resolved = await spec.resolve(ref);
    const result = spec.validate(resolved.manifest);
    const outcome = ValidationOutcome.from(result.errors, result.warnings ?? []);
    if (outcome.status === 'invalid') {
      throw new ManifestInvalidError(outcome);
    }
    return { ...resolved, outcome };
  }

  /**
   * Validate the submitted env, then seal the secrets.
   *
   * ⚠️ AN EMPTY VALUE ON A SECRET MEANS 「keep」, NOT 「clear」 (23 I-IMG-5). That is
   * forced by the read model: outbound secrets are masked to `''`, so a user who
   * merely re-submits the form they were shown would otherwise WIPE every secret they
   * did not retype.
   */
  private sealConfig(input: ImageConfigInput, previous: ImageConfigVO | null): ImageConfigVO {
    // 构造即校验 — throws `EnvValidationError` with EVERY violation and a `path` each.
    const validated = EnvVarSet.create(input.env);
    const env: StoredEnvEntry[] = validated.entries.map((entry) => {
      if (!entry.secret) return { key: entry.key, secret: false, value: entry.value };
      if (entry.value === '') {
        const kept = previous?.env.find((e) => e.key === entry.key && e.secret);
        if (kept?.valueEncrypted) {
          return { key: entry.key, secret: true, valueEncrypted: kept.valueEncrypted };
        }
        // No stored ciphertext to keep: an empty NEW secret is stored as an empty
        // sealed value rather than as plaintext — `secret: true` must never mean
        // 「plaintext in the JSON column」 (I-IMG-5).
      }
      return { key: entry.key, secret: true, valueEncrypted: this.cipher.seal(entry.value) };
    });
    return { env, cmdOverride: input.cmdOverride ?? previous?.cmdOverride };
  }

  private async mustFindManifest(id: string): Promise<ImageManifest> {
    const manifest = await this.manifests.findById(id);
    if (!manifest) throw new ImageNotFoundError(id);
    return manifest;
  }

  private async mustFindImage(id: string): Promise<Image> {
    const image = await this.images.findById(id);
    if (!image) throw new ImageNotFoundError(id);
    return image;
  }
}

/** One row of `listBuiltinAnchors()` — the shape the lineage check compares against. */
type LineageAnchor = Awaited<ReturnType<ImageManifestRepository['listBuiltinAnchors']>>[number];

/**
 * Both halves of the lineage judgement (04 §7 ★血统).
 *
 * ⚠️ THEY TRAVEL TOGETHER BECAUSE ONE COMPARISON PRODUCES BOTH. `finding === null`
 * and `derivedFromDigest !== null` are the same event seen from the two sides —
 * splitting them across two calls would mean walking the anchors twice and would let
 * a row be admitted by one walk and attributed by another.
 */
interface LineageVerdict {
  /** `null` ⇒ admitted; otherwise the `IMAGE_BASE_REQUIRED` to surface. */
  finding: ValidationIssue | null;
  /** Digest of the CLOSEST built-in ancestor, or `null` when there is none. */
  derivedFromDigest: string | null;
}

/**
 * `validate()` judged the manifest `invalid` at registration ⇒ 422, and NOTHING is
 * stored (24 §7.2). The findings ride out in the envelope's `details[]`, which is
 * where `IMAGE_TMUX_MISSING` lives — it is never a top-level `code` (10 §6.8).
 */
export class ManifestInvalidError extends Error {
  constructor(readonly outcome: ValidationOutcome) {
    super('镜像不满足平台约定，未注册');
    this.name = 'ManifestInvalidError';
  }
}
