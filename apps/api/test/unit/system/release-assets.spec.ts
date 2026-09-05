import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AssetManifestError,
  ASSET_MANIFEST_NAME,
  readAssetManifest,
  assetPresent,
  sha256Of,
  verifyAsset,
} from '../../../src/platform/system/preset-image/release-assets';
import type { ReleaseAsset } from '../../../src/platform/system/preset-image/provision-plan';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'assets-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const GOOD: ReleaseAsset = {
  id: 'boxlite-sandbox-linux-arm64',
  provider: 'boxlite',
  platform: 'linux/arm64',
  kind: 'oci-layout',
  image: 'ghcr.io/xeonice/cap-boxlite-sandbox:v0.26.0',
  asset: 'cap-boxlite-sandbox-v0.26.0-linux-arm64.oci.tar.zst',
  sha256: 'x',
  sizeBytes: 430_725_526,
};

async function writeManifest(doc: unknown): Promise<void> {
  await writeFile(join(dir, ASSET_MANIFEST_NAME), JSON.stringify(doc), 'utf8');
}

describe('readAssetManifest', () => {
  it('读得出结构完整的资产', async () => {
    await writeManifest({ schemaVersion: 1, assets: [GOOD] });
    const got = await readAssetManifest(dir);
    expect(got).toHaveLength(1);
    expect(got[0]!.provider).toBe('boxlite');
  });

  it('⛔ schemaVersion 不认识 ⇒ 整份拒，**不做尽力而为的解析**', async () => {
    await writeManifest({ schemaVersion: 2, assets: [GOOD] });
    await expect(readAssetManifest(dir)).rejects.toThrow(AssetManifestError);
    await expect(readAssetManifest(dir)).rejects.toThrow('只认识 1');
  });

  it('⛔ 单条资产缺字段 ⇒ 只跳过它，**不整份拒**（向前兼容的发布不该打死老平台）', async () => {
    await writeManifest({
      schemaVersion: 1,
      assets: [GOOD, { id: 'future', provider: 'newvmm' }, { ...GOOD, id: 'b', provider: 'aio' }],
    });
    const got = await readAssetManifest(dir);
    expect(got.map((a) => a.id)).toEqual(['boxlite-sandbox-linux-arm64', 'b']);
  });

  it('kind 不在闭集里的那条也跳过', async () => {
    await writeManifest({ schemaVersion: 1, assets: [{ ...GOOD, kind: 'squashfs' }] });
    expect(await readAssetManifest(dir)).toHaveLength(0);
  });

  it('清单不存在 / 不是 JSON / 没有 assets ⇒ 各自报得出**是哪一种**', async () => {
    await expect(readAssetManifest(dir)).rejects.toThrow('读不到资产清单');
    await writeFile(join(dir, ASSET_MANIFEST_NAME), '{ 不是 json', 'utf8');
    await expect(readAssetManifest(dir)).rejects.toThrow('不是合法 JSON');
    await writeManifest({ schemaVersion: 1 });
    await expect(readAssetManifest(dir)).rejects.toThrow('没有 assets 数组');
  });
});

describe('verifyAsset —— 对不上就停在这里', () => {
  it('sha256 对得上 ⇒ 放行', async () => {
    await writeFile(join(dir, GOOD.asset), 'hello', 'utf8');
    const real = await sha256Of(join(dir, GOOD.asset));
    await expect(verifyAsset(dir, { ...GOOD, sha256: real })).resolves.toBeUndefined();
  });

  it('⛔ 对不上 ⇒ 抛，且错误里要说清「没有装载」', async () => {
    await writeFile(join(dir, GOOD.asset), 'tampered', 'utf8');
    await expect(verifyAsset(dir, GOOD)).rejects.toThrow('sha256 对不上');
    await expect(verifyAsset(dir, GOOD)).rejects.toThrow('没有装载');
  });

  it('sha256Of 与 node 自己算的一致（不是自证）', async () => {
    const { createHash } = await import('node:crypto');
    await writeFile(join(dir, 'x'), 'abc', 'utf8');
    expect(await sha256Of(join(dir, 'x'))).toBe(createHash('sha256').update('abc').digest('hex'));
  });
});

describe('assetPresent —— ⛔「没下载」与「校验失败」不是一回事', () => {
  it('文件在、大小对 ⇒ 放行', async () => {
    await writeFile(join(dir, GOOD.asset), 'x'.repeat(GOOD.sizeBytes > 8 ? 8 : 1), 'utf8');
    await expect(verifyPresent(8)).resolves.toBeUndefined();
  });

  it('⛔ 文件不在 ⇒ 说「先把资产下下来」，**不是**说校验失败', async () => {
    await expect(assetPresent(dir, GOOD)).rejects.toThrow('资产文件不在');
    await expect(assetPresent(dir, GOOD)).rejects.toThrow('下载');
  });

  it('⛔ 截断的下载 ⇒ 提前一个阶段说出来，而不是等完一次 431MB 的 sha256', async () => {
    await writeFile(join(dir, GOOD.asset), 'short', 'utf8');
    await expect(assetPresent(dir, GOOD)).rejects.toThrow('大小对不上');
    // 这一格必须说清它**没有**走到后面两步 —— 否则用户不知道镜像有没有被动过。
    await expect(assetPresent(dir, GOOD)).rejects.toThrow('没有装载');
  });

  it('两种失败的话术不同 —— 合成一条就等于把阶段这个产出弄丢了', async () => {
    const missing = await assetPresent(dir, GOOD).catch((e: Error) => e.message);
    await writeFile(join(dir, GOOD.asset), 'short', 'utf8');
    const truncated = await assetPresent(dir, GOOD).catch((e: Error) => e.message);
    expect(missing).not.toBe(truncated);
  });
});

/** 大小对得上的那一条 —— 用一个小体积资产避免真写 431MB。 */
async function verifyPresent(size: number): Promise<void> {
  return assetPresent(dir, { ...GOOD, sizeBytes: size });
}
