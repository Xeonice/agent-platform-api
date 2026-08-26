import { describe, it, expect, beforeEach } from 'vitest';
import {
  IMAGE_BASE_REQUIRED,
  IMAGE_LABEL_TMUX,
  IMAGE_TMUX_MISSING,
  formatImageRef,
  parseImageRef,
} from '@platform/contracts';
import type {
  ImageSpecManifest,
  ImageSpecProvider,
  ImageSpecRegistry,
  ResolvedImage,
  ValidationResult,
} from '@platform/contracts';
import { UnitOfWorkBase, type Tx } from '@platform/shared-kernel';
import { createHash } from 'node:crypto';
import {
  ImageApplicationService,
  ManifestInvalidError,
} from '../../src/application/image-application.service';
import { ImageStateError } from '../../src/domain/errors/image-errors';
import { Image } from '../../src/domain/entities/image.entity';
import type { ImageManifest } from '../../src/domain/entities/image-manifest.entity';
import type { ImageRepository } from '../../src/domain/repositories/image.repository';
import type { ImageManifestRepository } from '../../src/domain/repositories/image-manifest.repository';
import type { EnvSecretCipher } from '../../src/domain/ports/env-secret.cipher.port';

/**
 * ★ 注册期准入：血统校验（04 §7 ★血统 / 23 I-IMG-*）。
 *
 * ── 这一层测的是什么，以及为什么不能测在 `validate()` 里 ─────────────────────────
 * 「这张镜像是不是基于平台预制镜像构建的」需要知道**平台注册过哪些 base**——那是库里
 * 的状态。`ImageSpecProvider.validate(manifest)` 契约上是纯判断（testkit IS-04），
 * 而且它是**可被第三方替换的 SPI**；把平台自己的准入策略塞进去，等于要求每个第三方
 * 实现替我们执行我们的策略。所以规则落在 application 层，用例也落在这里。
 *
 * ── 为什么用真的 `ImageApplicationService` + 内存仓储 ────────────────────────────
 * 这条规则的全部内容是「谁在什么顺序上被拒/被放行」，替身只替掉两样东西：registry
 * 出网（本来就不该在单测里）和 SQLite（`image-schema.spec.ts` 已经在 integration 层
 * 真跑迁移了）。判定逻辑本身是真的，包括「幂等命中不再复判」这条顺序。
 */

const NOW = new Date('2026-08-26T00:00:00.000Z');
const layer = (seed: string): string => `sha256:${createHash('sha256').update(seed).digest('hex')}`;

/** The platform base image's layers — one 「已经 77 层」 stand-in, shape-identical. */
const BASE_LAYERS = [layer('base-1'), layer('base-2'), layer('base-3')];

interface ScriptedImage {
  diffIds: string[];
  /** `false` ⇒ the image carries no `platform.tmux` label. */
  tmux?: boolean;
}

class ScriptedSpec implements ImageSpecProvider {
  readonly name = 'scripted';
  readonly images = new Map<string, ScriptedImage>();

  async resolve(ref: string): Promise<ResolvedImage> {
    const parsed = parseImageRef(ref);
    const reference = parsed.digest ?? parsed.tag ?? 'latest';
    const canonical = formatImageRef(parsed.name, reference);
    const scripted = this.images.get(canonical) ?? { diffIds: BASE_LAYERS };
    return await Promise.resolve({
      ref: canonical,
      digest: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
      entrypoint: ['/bin/sh'],
      resolvedAt: NOW.toISOString(),
      manifest: {
        name: parsed.name,
        version: reference,
        baseImage: parsed.name,
        entrypointContract: { workdir: '/', entrypoint: ['/bin/sh'] },
        supportedRuntimes: ['codex'],
        resourceDefaults: { cores: 1, ramMb: 512, diskMb: 1024 },
        labelsRequired: scripted.tmux === false ? [] : [IMAGE_LABEL_TMUX],
        diffIds: scripted.diffIds,
      },
    });
  }

  /** Always clean: this file is about ADMISSION, never about the spec judgement. */
  validate(_manifest: ImageSpecManifest): ValidationResult {
    return { valid: true, errors: [], warnings: [] };
  }
}

class FakeUow extends UnitOfWorkBase {
  protected runInTransaction<T>(work: () => T): T {
    return work();
  }
}

function makeService(): {
  service: ImageApplicationService;
  spec: ScriptedSpec;
  rows: () => ImageManifest[];
  setBuiltin: (imageId: string, builtin: boolean) => void;
} {
  const images = new Map<string, Image>();
  const manifests = new Map<string, ImageManifest>();
  let seq = 0;

  const imageRepo: ImageRepository = {
    findById: async (id) => await Promise.resolve(images.get(id) ?? null),
    findByName: async (name) =>
      await Promise.resolve([...images.values()].find((i) => i.name === name) ?? null),
    list: async () => await Promise.resolve([...images.values()]),
    saveSync: (_tx: Tx, image) => void images.set(image.id, image),
    deleteSync: (_tx: Tx, id) => void images.delete(id),
  };

  const manifestRepo: ImageManifestRepository = {
    findById: async (id) => await Promise.resolve(manifests.get(id) ?? null),
    findByDigest: async (imageId, digest) =>
      await Promise.resolve(
        [...manifests.values()].find((m) => m.imageId === imageId && m.digest === digest) ?? null,
      ),
    findActiveByVersion: async (imageId, version) =>
      await Promise.resolve(
        [...manifests.values()].find(
          (m) => m.imageId === imageId && m.version === version && m.isActive,
        ) ?? null,
      ),
    listByImage: async (imageId) =>
      await Promise.resolve([...manifests.values()].filter((m) => m.imageId === imageId)),
    listAll: async () => await Promise.resolve([...manifests.values()]),
    listSelectable: async () =>
      await Promise.resolve(
        [...manifests.values()].filter((m) => m.isActive && m.validation.status !== 'invalid'),
      ),
    listBuiltinAnchors: async () =>
      await Promise.resolve(
        [...manifests.values()]
          // ⚠️ NEWEST FIRST, like the SQL (`order by registered_at desc`). The tie
          // rule for 「两张锚点层列表一字不差」 is 「保留先出现的那张」, so a fake
          // that iterated in insertion order would exercise the opposite tie.
          .reverse()
          .filter((m) => images.get(m.imageId)?.isBuiltin === true)
          .map((m) => ({
            ref: formatImageRef(images.get(m.imageId)?.name ?? '', m.version),
            digest: m.digest,
            diffIds: m.diffIds,
          })),
      ),
    saveSync: (_tx: Tx, manifest) => void manifests.set(manifest.id, manifest),
    deactivateOthersSync: () => undefined,
    deleteSync: (_tx: Tx, id) => void manifests.delete(id),
    countReferencingSandboxes: async () => await Promise.resolve(0),
  };

  const cipher: EnvSecretCipher = {
    seal: () => ({ blob: '', iv: '', authTag: '', keyId: 'k' }),
    open: () => '',
  };

  const spec = new ScriptedSpec();
  const registry: ImageSpecRegistry = {
    defaultProvider: spec.name,
    register: () => undefined,
    get: () => spec,
    has: () => true,
    list: () => [spec],
  };

  const service = new ImageApplicationService(
    imageRepo,
    manifestRepo,
    registry,
    cipher,
    new FakeUow(),
    { publishInTx: () => undefined, subscribe: () => undefined },
    { now: () => NOW },
    {
      next: () => {
        seq += 1;
        return `id-${String(seq)}`;
      },
    },
  );

  return {
    service,
    spec,
    rows: () => [...manifests.values()],
    setBuiltin: (imageId, builtin) => {
      const existing = images.get(imageId);
      if (!existing) throw new Error(`no image ${imageId}`);
      images.set(
        imageId,
        Image.rehydrate({
          id: existing.id,
          name: existing.name,
          ownerRef: existing.ownerRef,
          isBuiltin: builtin,
          createdAt: existing.createdAt,
        }),
      );
    },
  };
}

const ROOT = 'registry.example/platform/base:v1';
let h: ReturnType<typeof makeService>;

beforeEach(() => {
  h = makeService();
  h.spec.images.set(ROOT, { diffIds: BASE_LAYERS });
});

/** Register the platform root exactly the way `ImageSeeder` does. */
async function seedRoot(): Promise<void> {
  await h.service.registerImage(ROOT, { builtin: true });
}

describe('根镜像（builtin）：豁免血统，但必须声明 tmux', () => {
  it('空库里也能注册 —— 它就是锚点，没有更早的祖先可比', async () => {
    // MUTATION: 把 `assertAdmissible` 里的 `if (builtin) { …; return; }` 去掉 ⇒ 本条
    // 撞上「平台还没有可用的预制镜像」那条 409，播种从此永远失败，平台起不来。
    const result = await h.service.registerImage(ROOT, { builtin: true });
    expect(result.created).toBe(true);
    expect(h.rows()).toHaveLength(1);
  });

  it('⭐ 根镜像没声明 platform.tmux ⇒ IMAGE_TMUX_MISSING，且不落库', async () => {
    h.spec.images.set(ROOT, { diffIds: BASE_LAYERS, tmux: false });
    // ⚠️ 这条防的是「运维方把 SANDBOX_DEFAULT_IMAGE 指错了」，**不是**防谎报——
    // 标签会被派生镜像继承，防不住谎报；谎报由运行期 `command -v tmux` 抓
    // （⇒ IMAGE_CONTRACT_VIOLATION）。两层各管一半，见 04 §7 ★血统。
    await expect(h.service.registerImage(ROOT, { builtin: true })).rejects.toBeInstanceOf(
      ManifestInvalidError,
    );
    await h.service.registerImage(ROOT, { builtin: true }).catch((e: unknown) => {
      expect((e as ManifestInvalidError).outcome.errors.map((f) => f.code)).toContain(
        IMAGE_TMUX_MISSING,
      );
    });
    expect(h.rows(), 'invalid 不落库（24 §7.2）').toHaveLength(0);
  });

  it('派生镜像**不**做这条 tmux 声明检查 —— 标签是继承来的，问它等于问它祖宗', async () => {
    await seedRoot();
    // 一张老老实实 FROM base 的镜像，自己一个 platform.* 都没写。在旧口径下这会被判
    // MANIFEST_INVALID；而实测表明它其实继承了 base 的全部三个标签，所以那个判定
    // 既拦不住坏镜像，也拦得住好镜像。
    h.spec.images.set('registry.example/user/app:v1', {
      diffIds: [...BASE_LAYERS, layer('app')],
      tmux: false,
    });
    const result = await h.service.registerImage('registry.example/user/app:v1');
    expect(result.created).toBe(true);
  });
});

describe('派生镜像：diff_ids 前缀 = 可验证的血统', () => {
  beforeEach(seedRoot);

  it('base + 新层 ⇒ 放行', async () => {
    h.spec.images.set('registry.example/user/app:v1', {
      diffIds: [...BASE_LAYERS, layer('app')],
    });
    await expect(h.service.registerImage('registry.example/user/app:v1')).resolves.toMatchObject({
      created: true,
    });
  });

  it('⭐ 与 base **完全相同** ⇒ 也放行：LABEL / ENV / CMD 不产生新层', async () => {
    // 实测：给基础镜像加标签的派生镜像，diff_ids 与基础一字不差。要求「严格更长」
    // 会把最正当的一种派生（只加标签）判成非法。
    // MUTATION: `isDerivedFrom` 里把 `candidate.length < base.length` 改成 `<=` ⇒ 本条红。
    h.spec.images.set('registry.example/user/labelled:v1', { diffIds: [...BASE_LAYERS] });
    await expect(
      h.service.registerImage('registry.example/user/labelled:v1'),
    ).resolves.toMatchObject({ created: true });
  });

  it('⭐ 毫无关系的镜像 ⇒ IMAGE_BASE_REQUIRED，且不落库，message 说得出下一步', async () => {
    h.spec.images.set('registry.example/user/alien:v1', { diffIds: [layer('alien')] });
    const before = h.rows().length;

    const err = await h.service
      .registerImage('registry.example/user/alien:v1')
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ManifestInvalidError);
    const outcome = (err as ManifestInvalidError).outcome;
    expect(outcome.status).toBe('invalid');
    expect(outcome.errors.map((f) => f.code)).toContain(IMAGE_BASE_REQUIRED);
    // ⚠️ 出路必须是可执行的一句话，而且要**点名那张镜像**：「请用平台预制镜像」是
    // 一句正确但没法照做的话——用户不知道是哪一张。
    const finding = outcome.errors.find((f) => f.code === IMAGE_BASE_REQUIRED);
    expect(finding?.message).toContain('FROM');
    expect(finding?.message).toContain(ROOT);
    expect(finding?.path).toBeTruthy();
    expect(h.rows().length).toBe(before);
  });

  it('⭐ 候选比 base **更短**（是 base 的前缀）⇒ 拒绝：方向反了不算派生', async () => {
    // 这是最容易写反的一处：`isDerivedFrom(a, b)` 问的是「a 是不是以 b 开头」，
    // 而不是「两者有共同前缀」。base 本身就是「以候选开头」的，把顺序写反会让
    // **祖先**被判成自己的派生。
    // MUTATION: 把实现改成 `candidate.every((l, i) => base[i] === l)` ⇒ 本条红。
    h.spec.images.set('registry.example/user/ancestor:v1', { diffIds: [BASE_LAYERS[0]] });
    await expect(
      h.service.registerImage('registry.example/user/ancestor:v1'),
    ).rejects.toBeInstanceOf(ManifestInvalidError);
  });

  it('中间层不同、末尾碰巧一样 ⇒ 拒绝：比的是前缀，不是集合', async () => {
    h.spec.images.set('registry.example/user/lookalike:v1', {
      diffIds: [BASE_LAYERS[0], layer('different'), BASE_LAYERS[2], layer('extra')],
    });
    await expect(
      h.service.registerImage('registry.example/user/lookalike:v1'),
    ).rejects.toBeInstanceOf(ManifestInvalidError);
  });
});

describe('⭐ 鸡生蛋：库里没有可用锚点时**拒绝**，而且拒的码不一样', () => {
  it('一个 builtin 都没有 ⇒ INVALID_STATE(409)，不是 IMAGE_BASE_REQUIRED，更不是放行', async () => {
    h.spec.images.set('registry.example/user/app:v1', { diffIds: [...BASE_LAYERS, layer('app')] });

    const err = await h.service
      .registerImage('registry.example/user/app:v1')
      .then(() => null)
      .catch((e: unknown) => e);

    // ⚠️ 放行是最坏的选项：那等于这条约束在播种失败的部署上**根本不存在**，
    // 而没有任何东西会告诉运维方它不存在了。
    expect(err, '不能静默放行').not.toBeNull();
    // ⚠️ 也不能报 IMAGE_BASE_REQUIRED —— 那句话在说「你的镜像不对」，而事实是
    // **平台没准备好**；把用户支去改 Dockerfile 是让他修一个没坏的东西。
    expect(err).toBeInstanceOf(ImageStateError);
    expect(err).not.toBeInstanceOf(ManifestInvalidError);
    expect((err as Error).message).toContain('预制镜像');
    expect(h.rows()).toHaveLength(0);
  });

  it('有 builtin 但 diff_ids 为空（切片前的存量行）⇒ 同样拒绝，不当成「空前缀匹配一切」', async () => {
    // `[]` 是任何数组的前缀。若锚点不过滤空值，一行无法描述的存量数据就会让规则
    // **对所有镜像放行**——规则还在，只是永远不再拒绝任何东西。
    // MUTATION: 去掉 `listBuiltinAnchors()` 后面的 `.filter(a => a.diffIds.length > 0)`，
    // 或去掉 `isDerivedFrom` 里的 `base.length === 0` 守卫 ⇒ 本条红。
    await h.service.registerImage(ROOT, { builtin: true });
    const rootRow = h.rows()[0];
    Object.defineProperty(rootRow, 'diffIds', { value: [], writable: false });

    h.spec.images.set('registry.example/user/alien:v1', { diffIds: [layer('alien')] });
    await expect(h.service.registerImage('registry.example/user/alien:v1')).rejects.toBeInstanceOf(
      ImageStateError,
    );
  });
});

describe('锚点的取用口径', () => {
  it('停用（is_active=false）的预制镜像仍然是有效锚点 —— 血统是历史事实', async () => {
    await seedRoot();
    const rootRow = h.rows()[0];
    rootRow.deactivate(NOW);
    // 运维方把预制镜像换代（v1 停用、v2 上线）不该让所有基于 v1 构建的镜像
    // 突然注册不了：它们**当初确实**是基于平台镜像构建的，那件事不会因为
    // 指针移动而变假。
    h.spec.images.set('registry.example/user/app:v1', { diffIds: [...BASE_LAYERS, layer('app')] });
    await expect(h.service.registerImage('registry.example/user/app:v1')).resolves.toMatchObject({
      created: true,
    });
  });

  it('幂等命中（同一 digest 再注册一次）不再复判血统', async () => {
    await seedRoot();
    // 同一坐标再来一遍：这张镜像早就在目录里了，它进目录那一刻已经过了这道门。
    // 再判一次只会让「预制镜像被换掉」这类平台侧变动，把一次已完成的注册变成失败。
    const again = await h.service.registerImage(ROOT, { builtin: true });
    expect(again.created).toBe(false);
    expect(h.rows()).toHaveLength(1);
  });
});

describe('⭐ 血统不止判「过不过」，还要记下「基于哪一张」（derived_from_digest）', () => {
  /**
   * 判定那一刻已经比对完了、也知道匹配上了哪一个锚点，只是以前把答案扔了。扔掉的后果不是
   * 「少个字段」：平台从此**没有任何办法**知道谁基于谁——卡片显示不出「基于 X」，平台发新
   * base 之后也说不出哪些客户自定义镜像该重建。本组用例守的是那个答案真的被带出来、并且
   * 带出来的是**对的那一张**。
   */
  it('派生镜像记下匹配到的锚点 digest —— DTO 与库里的行都要有', async () => {
    const root = await h.service.registerImage(ROOT, { builtin: true });
    h.spec.images.set('registry.example/user/app:v1', { diffIds: [...BASE_LAYERS, layer('app')] });

    const registered = await h.service.registerImage('registry.example/user/app:v1');

    // MUTATION: 把 `lineageVerdict` 里 `return { finding: null, derivedFromDigest: match.digest }`
    // 改成 `derivedFromDigest: null` ⇒ 本条红。
    expect(registered.manifest.derivedFromDigest).toBe(root.manifest.digest);
    // ⚠️ 也要断言**库里的行**，不只是回包。两者走的是不同的路（`ImageMapper.toDto` vs
    // `saveSync`），只测回包会让「算出来了但没落库」保持全绿。
    const stored = h.rows().find((m) => m.id === registered.manifest.id);
    expect(stored?.derivedFromDigest).toBe(root.manifest.digest);
    // 而且它必须是**锚点的 digest**，不是自己的：拿自己的 digest 填这一列，字段永远非空、
    // 看起来一切正常，血统图却是一堆自环。
    expect(stored?.derivedFromDigest).not.toBe(registered.manifest.digest);
  });

  it('根镜像（builtin）的 derivedFromDigest 是 null —— 它就是锚点，没有平台祖先', async () => {
    // MUTATION: 把 `assertAdmissible` 的 builtin 分支改成 `return resolved.digest` ⇒ 本条红。
    // 那个自环会让「基于 X」在根镜像卡片上显示成它自己，也会让将来的 rebase 逻辑
    // 把根镜像当成一张需要跟随自己升级的派生镜像。
    const root = await h.service.registerImage(ROOT, { builtin: true });
    expect(root.manifest.derivedFromDigest).toBeNull();
    expect(h.rows()[0].derivedFromDigest).toBeNull();
  });

  it('血统不过关的镜像根本不落库，自然也没有这一列可写', async () => {
    await seedRoot();
    h.spec.images.set('registry.example/user/alien:v1', { diffIds: [layer('alien')] });
    await expect(h.service.registerImage('registry.example/user/alien:v1')).rejects.toBeInstanceOf(
      ManifestInvalidError,
    );
    expect(h.rows()).toHaveLength(1);
  });
});

describe('⭐ 多个锚点同时匹配：取**最长前缀**，也就是最近的那个祖先', () => {
  /**
   * 这不是假想的边界。`platform/base` 与 `platform/sandbox` 是祖孙——后者 `FROM` 前者，两张
   * 都是平台预制镜像、都在 `listBuiltinAnchors()` 里。于是一张 `FROM platform/sandbox` 的用户
   * 镜像**同时**是两者的后代，两条前缀都成立，「匹配上了」这句话不足以定位到一张。
   *
   * 取最长的那个前缀 = 取最近的祖先 = 取用户真的写在 Dockerfile 第一行的那张。取错了不会有
   * 任何东西报错：卡片上的「基于 X」会显示成一个用户从没写过的坐标，而将来据此做自动 rebase
   * 会把镜像 rebase 到**祖父**那一张上去。
   */
  const PARENT = 'registry.example/platform/sandbox:v1';
  const CHILD = 'registry.example/user/app:v1';
  const PARENT_LAYERS = [...BASE_LAYERS, layer('sandbox')];

  /**
   * 两张锚点都种下，`order` 决定注册顺序。
   *
   * ⚠️ 两个顺序都要跑，而且这是本组用例的关键。`listBuiltinAnchors()` 按注册时间倒序返回，
   * 所以「取第一个匹配到的」和「取最后一个匹配到的」这两种写法，各自都能在**某一个**顺序下
   * 碰巧答对。只测一个顺序 = 给一半的错误实现发通行证。
   */
  async function seedAnchors(order: 'base-first' | 'sandbox-first'): Promise<{
    base: string;
    sandbox: string;
  }> {
    h.spec.images.set(PARENT, { diffIds: PARENT_LAYERS });
    const refs = order === 'base-first' ? [ROOT, PARENT] : [PARENT, ROOT];
    const digests = new Map<string, string>();
    for (const ref of refs) {
      const r = await h.service.registerImage(ref, { builtin: true });
      digests.set(ref, r.manifest.digest);
    }
    return { base: digests.get(ROOT) ?? '', sandbox: digests.get(PARENT) ?? '' };
  }

  it.each(['base-first', 'sandbox-first'] as const)(
    'FROM sandbox 的镜像记成 sandbox（注册顺序 %s）—— 不是它的祖父 base',
    async (order) => {
      const anchors = await seedAnchors(order);
      expect(anchors.base).not.toBe(anchors.sandbox);
      h.spec.images.set(CHILD, { diffIds: [...PARENT_LAYERS, layer('app')] });

      const registered = await h.service.registerImage(CHILD);

      // MUTATION: 把 `lineageVerdict` 里的 `a.diffIds.length > best.diffIds.length`
      // 改成 `<`（取最短）、或换成 `anchors.find(a => isDerivedFrom(...))`（取第一个）
      // ⇒ 两个顺序里至少有一个红。
      expect(registered.manifest.derivedFromDigest).toBe(anchors.sandbox);
      expect(registered.manifest.derivedFromDigest).not.toBe(anchors.base);
    },
  );

  it('祖孙两张锚点都在时，直接 FROM base 的那张仍然记成 base', async () => {
    // ⚠️ 反向守卫：一个「永远取最长的那张锚点」而**不看是否真的匹配**的实现，会把这张
    // 只基于 base 的镜像也记成 sandbox —— 它从来没装过 sandbox 那一层。
    const anchors = await seedAnchors('base-first');
    h.spec.images.set('registry.example/user/plain:v1', {
      diffIds: [...BASE_LAYERS, layer('plain')],
    });
    const registered = await h.service.registerImage('registry.example/user/plain:v1');
    expect(registered.manifest.derivedFromDigest).toBe(anchors.base);
  });

  it('两张锚点层列表一字不差时取先出现的那张（最新注册的），不报错也不挑第二张', async () => {
    // 长度相同 ⇒ 两张锚点指向同一份 bits，取哪张都对；这里钉住的是「不会因为并列而
    // 回退成 null」——那会让一张完全合规的镜像丢掉血统记录。
    const twin = 'registry.example/platform/twin:v1';
    h.spec.images.set(twin, { diffIds: [...BASE_LAYERS] });
    await h.service.registerImage(ROOT, { builtin: true });
    const later = await h.service.registerImage(twin, { builtin: true });

    h.spec.images.set(CHILD, { diffIds: [...BASE_LAYERS, layer('app')] });
    const registered = await h.service.registerImage(CHILD);
    expect(registered.manifest.derivedFromDigest).toBe(later.manifest.digest);
  });
});

describe('⭐ 预检与注册必须同口径（POST /api/images/validate）', () => {
  it('预检就报 IMAGE_BASE_REQUIRED —— 不能预检说 ✅、保存说 422', async () => {
    await seedRoot();
    h.spec.images.set('registry.example/user/alien:v1', { diffIds: [layer('alien')] });
    // 向导的流程是「提交 URI → 三级反馈 → [保存]」。两个端点各自内部正确、合起来
    // 自相矛盾，正是本仓反复付账的那种缺陷形态。
    const outcome = await h.service.validateImage('registry.example/user/alien:v1');
    expect(outcome.status).toBe('invalid');
    expect(outcome.errors.map((e) => e.code)).toContain(IMAGE_BASE_REQUIRED);
  });

  it('合规镜像预检为 valid，且预检不落任何库', async () => {
    await seedRoot();
    h.spec.images.set('registry.example/user/app:v1', { diffIds: [...BASE_LAYERS, layer('app')] });
    const before = h.rows().length;
    const outcome = await h.service.validateImage('registry.example/user/app:v1');
    expect(outcome.status).toBe('valid');
    expect(h.rows().length).toBe(before);
  });
});
