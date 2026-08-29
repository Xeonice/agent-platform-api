import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ImageFacadeAdapter } from '../../src/application/image-facade.adapter';
import type { ImageRepository } from '../../src/domain/repositories/image.repository';
import type { ImageManifestRepository } from '../../src/domain/repositories/image-manifest.repository';
import type { EnvSecretCipher } from '../../src/domain/ports/env-secret.cipher.port';

/**
 * ★ 「这张镜像没注册」在**两种**情况下说的不是同一件事——而此前平台只有一句话。
 *
 * 全新部署里没人选镜像 ⇒ 走平台默认 ⇒ 没播种成功 ⇒ 向导弹出
 * 「镜像 'ghcr.io/agent-infra/sandbox:latest' 尚未注册，请先在镜像管理里注册它」。
 * 用户照做，注册会被血统检查拒（上游镜像不是平台预制镜像，没有 `platform.tmux`）——
 * **他做了消息叫他做的事，失败了，还会以为是自己做错了。**
 *
 * ⚠️ 而开机日志早就说对了（`ImageSeeder` 纪律②）。同一件事两条提示、两个不同的下一步，
 * 用户看得见的那条是错的。本文件钉的就是这个区分。
 *
 * ⚠️ `resolveForTask` 在此之前**一条单测都没有**——它是建 Task 的门口，
 * 而门口说错话不会让任何测试变红。
 */
type MinimalImages = Pick<ImageRepository, 'findById' | 'findByName'>;
type MinimalManifests = Pick<
  ImageManifestRepository,
  'findById' | 'findActiveByVersion' | 'listByImage'
>;

/** 空库 —— 全新部署刚起来、播种没成功的样子。 */
function emptyRepos(): { images: MinimalImages; manifests: MinimalManifests } {
  return {
    images: {
      findById: vi.fn(async () => await Promise.resolve(null)),
      findByName: vi.fn(async () => await Promise.resolve(null)),
    },
    manifests: {
      findById: vi.fn(async () => await Promise.resolve(null)),
      findActiveByVersion: vi.fn(async () => await Promise.resolve(null)),
      listByImage: vi.fn(async () => await Promise.resolve([])),
    },
  };
}

const cipher: EnvSecretCipher = {
  seal: () => ({ ciphertext: '', iv: '', tag: '' }) as ReturnType<EnvSecretCipher['seal']>,
  open: () => '',
};

function facade(): ImageFacadeAdapter {
  const { images, manifests } = emptyRepos();
  return new ImageFacadeAdapter(
    images as ImageRepository,
    manifests as ImageManifestRepository,
    cipher,
  );
}

const prevRef = process.env.SANDBOX_DEFAULT_IMAGE;
beforeEach(() => {
  process.env.SANDBOX_DEFAULT_IMAGE = 'ghcr.io/agent-infra/sandbox:latest';
});
afterEach(() => {
  if (prevRef === undefined) delete process.env.SANDBOX_DEFAULT_IMAGE;
  else process.env.SANDBOX_DEFAULT_IMAGE = prevRef;
});

async function messageOf(selector?: string): Promise<string> {
  try {
    await facade().resolveForTask(selector, 'aio');
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected resolveForTask to reject');
}

describe('ImageFacade.resolveForTask —— 「没注册」的两种说法', () => {
  it('⭐ 没选镜像（走平台默认）⇒ **不许**叫用户去注册它', async () => {
    const msg = await messageOf(undefined);
    // MUTATION: 去掉 `usingPlatformDefault` 分支（两种情况共用一句话）⇒ 本条红。
    expect(msg).not.toContain('请先在镜像管理里注册它');
    // 说得出**真正的**下一步：预制镜像得是平台自己构建的那一张。
    expect(msg).toContain('预制镜像');
    expect(msg).toContain('platform-sandbox');
    // 并且指名当前配置，让人知道该改哪个 env。
    expect(msg).toContain('SANDBOX_DEFAULT_IMAGE');
    expect(msg).toContain('ghcr.io/agent-infra/sandbox:latest');
  });

  it('用户自己选的镜像没注册 ⇒ 原来那句仍然对', async () => {
    // ⚠️ 这条是上一条的**对照**：没有它，把两种情况都改成「去修预制镜像」也能全绿，
    //    而那对一个只是打错镜像名的用户同样是错的下一步。
    const msg = await messageOf('docker.io/myrepo/whatever:v1');
    expect(msg).toContain('请先在镜像管理里注册它');
    expect(msg).toContain('docker.io/myrepo/whatever:v1');
    expect(msg).not.toContain('platform-sandbox');
  });

  it('空白 selector 与不给 selector 同义（前端传空串是常态）', async () => {
    expect(await messageOf('   ')).toBe(await messageOf(undefined));
  });
});

/**
 * ★ ADR 决策 C：**两档的预制镜像不再是同一张**，于是门口多了一个此前不存在的问题
 * ——「这张镜像跑得在这一档上吗」。
 *
 * ⚠️ 本组用例最重要的一条是**最后那条**：单档部署下这条检查必须**恒为放行**。
 * 双档能力如果让今天绝大多数（单机单档）部署多出一种拒绝方式，那它带来的伤害
 * 会远大于它解决的问题。
 */
describe('resolveForTask —— 「这张镜像跑得在这一档上吗」（ADR 决策 C）', () => {
  const AIO_ANCHOR = 'registry.example/platform/sandbox:v1';
  const BOX_ANCHOR = 'registry.example/platform/boxlite:v1';

  interface Row {
    id: string;
    imageId: string;
    digest: string;
    derivedFromDigest: string | null;
  }
  const rows: Row[] = [
    { id: 'm-aio', imageId: 'img-aio', digest: 'sha256:aio', derivedFromDigest: null },
    { id: 'm-box', imageId: 'img-box', digest: 'sha256:box', derivedFromDigest: null },
    // 用户镜像：一张 FROM aio 锚点，一张 FROM boxlite 锚点
    { id: 'm-ua', imageId: 'img-ua', digest: 'sha256:ua', derivedFromDigest: 'sha256:aio' },
    { id: 'm-ub', imageId: 'img-ub', digest: 'sha256:ub', derivedFromDigest: 'sha256:box' },
    // aio 锚点的**下一个版本**（同一个 images 行）——升级场景
    { id: 'm-aio2', imageId: 'img-aio', digest: 'sha256:aio2', derivedFromDigest: null },
    { id: 'm-ua2', imageId: 'img-ua2', digest: 'sha256:ua2', derivedFromDigest: 'sha256:aio2' },
  ];
  const NAMES: Record<string, string> = {
    'registry.example/platform/sandbox': 'img-aio',
    'registry.example/platform/boxlite': 'img-box',
  };

  function twoTierFacade(): ImageFacadeAdapter {
    const manifestOf = (id: string): Record<string, unknown> => {
      const r = rows.find((x) => x.id === id)!;
      // ⚠️ 照 `ImageManifest` 实体**真实读到的**那几个字段做替身，而不是照猜的做。
      // 少一个（例如 `validation.status`）会让被测代码在断言前先抛 TypeError，
      // 于是用例「红了」，红的却不是它要测的那件事。
      return {
        ...r,
        version: 'v1',
        baseImage: 'base',
        isActive: true,
        validation: { status: 'valid' },
        entrypointContract: { workdir: '/', entrypoint: ['/bin/sh'] },
        supportedRuntimes: ['codex'],
        resourceDefaults: { cores: 1, ramMb: 512, diskMb: 1024 },
        labelsRequired: [],
        diffIds: [],
        registeredAt: new Date('2026-08-29T00:00:00.000Z'),
        env: {},
      };
    };
    const images: MinimalImages = {
      findById: vi.fn(
        async (id: string) => await Promise.resolve({ id, name: 'x', isBuiltin: true } as never),
      ),
      findByName: vi.fn(
        async (name: string) =>
          await Promise.resolve(
            NAMES[name] ? ({ id: NAMES[name], name, isBuiltin: true } as never) : null,
          ),
      ),
    };
    const manifests: MinimalManifests = {
      findById: vi.fn(
        async (id: string) =>
          await Promise.resolve(rows.some((r) => r.id === id) ? (manifestOf(id) as never) : null),
      ),
      findActiveByVersion: vi.fn(async () => await Promise.resolve(null)),
      listByImage: vi.fn(
        async (imageId: string) =>
          await Promise.resolve(
            rows.filter((r) => r.imageId === imageId).map((r) => manifestOf(r.id)) as never,
          ),
      ),
    };
    return new ImageFacadeAdapter(
      images as ImageRepository,
      manifests as ImageManifestRepository,
      cipher,
    );
  }

  const prevAio = process.env.SANDBOX_AIO_IMAGE;
  const prevBox = process.env.SANDBOX_BOXLITE_IMAGE;
  beforeEach(() => {
    process.env.SANDBOX_AIO_IMAGE = AIO_ANCHOR;
    process.env.SANDBOX_BOXLITE_IMAGE = BOX_ANCHOR;
  });
  afterEach(() => {
    if (prevAio === undefined) delete process.env.SANDBOX_AIO_IMAGE;
    else process.env.SANDBOX_AIO_IMAGE = prevAio;
    if (prevBox === undefined) delete process.env.SANDBOX_BOXLITE_IMAGE;
    else process.env.SANDBOX_BOXLITE_IMAGE = prevBox;
  });

  const codeOf = async (id: string, provider: string): Promise<string> => {
    try {
      await twoTierFacade().resolveForTask(id, provider);
      return 'OK';
    } catch (e) {
      if ((e as { code?: string }).code) return (e as { code: string }).code;
      throw e;
    }
  };

  it('⭐ 一张 FROM boxlite 锚点的镜像跑不了 aio 档 ⇒ IMAGE_PROVIDER_MISMATCH', async () => {
    // 没有这条，用户拿错镜像的后果是**在「启动实例」处静默超时**（boxlite 那张里
    // 根本没有 `:8080` 的 agent），而错误信息说的是「实例启动超时」——指向一个
    // 完全无关的方向。
    expect(await codeOf('m-ub', 'aio')).toBe('IMAGE_PROVIDER_MISMATCH');
    expect(await codeOf('m-ua', 'boxlite')).toBe('IMAGE_PROVIDER_MISMATCH');
  });

  it('各自档上的镜像正常放行，锚点自己也放行', async () => {
    expect(await codeOf('m-ua', 'aio')).toBe('OK');
    expect(await codeOf('m-ub', 'boxlite')).toBe('OK');
    expect(await codeOf('m-aio', 'aio')).toBe('OK');
    expect(await codeOf('m-box', 'boxlite')).toBe('OK');
  });

  it('⭐ 锚点升级（v1→v2，同一个仓库）不会让基于旧版的镜像集体失效', async () => {
    // ⚠️ 拿「当前配置那一张的 digest」比对的实现会在这里红：`m-ua` 派生自 sha256:aio，
    // 而运维方已经把这一档指向了 v2。它们什么都没变，也确实还能跑。
    // ⇒ 比的必须是**锚点所属的那一行 `images`**（同一仓库的所有版本）。
    process.env.SANDBOX_AIO_IMAGE = 'registry.example/platform/sandbox:v2';
    expect(await codeOf('m-ua', 'aio')).toBe('OK');
    expect(await codeOf('m-ua2', 'aio')).toBe('OK');
    // 而 boxlite 那张仍然跑不了 aio —— 放宽的是版本，不是档。
    expect(await codeOf('m-ub', 'aio')).toBe('IMAGE_PROVIDER_MISMATCH');
  });

  it('⭐⭐ 单档部署（两档指向同一张）⇒ 这条检查恒为放行', async () => {
    // 绝大多数部署是单机单档，不该因为平台长出双档能力而多出一种拒绝方式。
    process.env.SANDBOX_AIO_IMAGE = AIO_ANCHOR;
    process.env.SANDBOX_BOXLITE_IMAGE = AIO_ANCHOR;
    expect(await codeOf('m-ua', 'aio')).toBe('OK');
    expect(await codeOf('m-ua', 'boxlite')).toBe('OK');
  });

  it('这一档的锚点还没播种成功 ⇒ **不拦**（证明不了不兼容）', async () => {
    // 少报是降级（可能撞上一次启动超时），多报是撒谎（把一张能跑的镜像拦下来，
    // 而用户没有任何办法自证）。「一张预制镜像都没有」由另一条路负责说。
    process.env.SANDBOX_AIO_IMAGE = 'registry.example/platform/never-seeded:v1';
    expect(await codeOf('m-ub', 'aio')).toBe('OK');
  });
});
