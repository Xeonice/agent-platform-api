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
    await facade().resolveForTask(selector);
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
