import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReleaseAsset } from './provision-plan';

/**
 * 发布资产清单（`cap-image-assets.json`，`schemaVersion: 1`）的读取与校验。
 *
 * ── 为什么平台要认识这个文件 ────────────────────────────────────────────────
 * 发布侧**早就**有一套完整的镜像供给机制：按 provider × platform 列资产、带 sha256、
 * 带体积、可离线下载。而产品对它一无所知，于是在一台**资产就在硬盘上**的机器上，
 * 诊断照样说「去 docker build 一个 13GB 的东西」。⇒ 让产品认识它（P21-8 §2 ⇒ 新判据）。
 *
 * ⚠️ **只读不写。** 清单是发布流程的产物，平台是它的消费者。平台去改它等于两个真相源。
 */

/** 清单文件名 —— 发布侧固定这个名字，平台按名字找。 */
export const ASSET_MANIFEST_NAME = 'cap-image-assets.json';

/** 平台认得的 `schemaVersion`。 */
export const SUPPORTED_SCHEMA_VERSION = 1;

export class AssetManifestError extends Error {}

/**
 * 读清单。
 *
 * ⚠️ **`schemaVersion` 不认识就整份拒掉，不做「尽力而为」的解析。** 一份将来格式的清单里
 * `sizeBytes` 的含义可能变（压缩前/后），而进度条与磁盘预估都挂在那个数上 —— 猜错了
 * 用户看到的是一个一直对不上的进度条，比直接说「不认识这个版本」糟得多。
 *
 * ⚠️ **缺字段的单条资产跳过，不整份拒**：清单里多出一条平台还不认识的资产（新 provider、
 * 新 kind）不该让**已经认识的那几条**一起失效 —— 那会让一次向前兼容的发布把老平台打死。
 */
export async function readAssetManifest(dir: string): Promise<readonly ReleaseAsset[]> {
  const path = join(dir, ASSET_MANIFEST_NAME);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    throw new AssetManifestError(`读不到资产清单 ${path}：${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AssetManifestError(`资产清单不是合法 JSON（${path}）：${(e as Error).message}`);
  }

  const doc = parsed as { schemaVersion?: unknown; assets?: unknown };
  if (doc.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new AssetManifestError(
      `资产清单的 schemaVersion 是 ${String(doc.schemaVersion)}，平台只认识 ${String(SUPPORTED_SCHEMA_VERSION)} —— ` +
        '不按尽力而为解析：字段含义可能已经变了，猜错会让进度与磁盘预估全都对不上',
    );
  }
  if (!Array.isArray(doc.assets)) {
    throw new AssetManifestError('资产清单里没有 assets 数组');
  }

  return doc.assets.filter(isCompleteAsset);
}

/** 一条资产要能用，这几个字段一个都不能少 —— 少了就跳过它，而不是整份拒。 */
function isCompleteAsset(a: unknown): a is ReleaseAsset {
  const o = a as Partial<ReleaseAsset>;
  return (
    typeof o.id === 'string' &&
    typeof o.provider === 'string' &&
    typeof o.platform === 'string' &&
    (o.kind === 'docker-archive' || o.kind === 'oci-layout') &&
    typeof o.image === 'string' &&
    typeof o.asset === 'string' &&
    typeof o.sha256 === 'string' &&
    typeof o.sizeBytes === 'number'
  );
}

/**
 * 算一个文件的 sha256。
 *
 * ⚠️ **流式，不 `readFile`**：资产是 431MB–2GB 量级，整份读进内存会在一台内存紧张的部署
 * 机上把平台自己打死 —— 而这一步的全部目的正是「别把坏东西装进去」。
 */
export async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * 资产文件**在不在**（以及大小对不对）。
 *
 * ⛔ **它必须独立于 sha256 校验存在**（2026-09-05 自查补）。此前 `fetch` 阶段不查文件、
 * 直接报 `ok「资产已在本机」`，文件缺失时会在**下一个阶段**以一个 `ENOENT` 冒出来 ——
 * 于是「资产没下载」被归到了「校验失败」头上。而这两件事的下一步完全不同：
 * 一个是去把资产下下来，一个是这份资产坏了要换一份。
 * ⚠️ **阶段归错，等于把「失败在哪一步」这个唯一的产出弄丢了。**
 *
 * ⚠️ 顺带比 `size`：它几乎不要钱（一次 `stat`），而**截断的下载**是这一格最常见的坏法
 * —— 提前一个阶段说出来，比让用户等完一次 431MB 的 sha256 再说「对不上」便宜得多。
 */
export async function assetPresent(dir: string, asset: ReleaseAsset): Promise<void> {
  const path = join(dir, asset.asset);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (e) {
    throw new AssetManifestError(
      `资产文件不在：${path}（${(e as Error).message}）。` +
        '⇒ 先把发布资产下载到 SANDBOX_IMAGE_ASSETS_DIR，或改用别的搬运源',
    );
  }
  if (size !== asset.sizeBytes) {
    throw new AssetManifestError(
      `资产文件大小对不上：清单说 ${String(asset.sizeBytes)} 字节，实际 ${String(size)} 字节。` +
        '⇒ 多半是一次被截断的下载，重新下载这一份（⛔ 没有走到校验那一步，也没有装载）',
    );
  }
}

/**
 * 校验一条资产的字节。
 *
 * ⛔ **对不上必须停在这里，绝不继续装载。** 一份损坏/被替换的镜像装进 registry 之后，
 * 它会以「平台预制镜像」的身份跑每一个 Task —— 那是这条链上最贵的一次失败。
 * 而校验的代价只是一次顺序读。
 */
export async function verifyAsset(dir: string, asset: ReleaseAsset): Promise<void> {
  const path = join(dir, asset.asset);
  const actual = await sha256Of(path);
  if (actual !== asset.sha256) {
    throw new AssetManifestError(
      `资产 ${asset.asset} 的 sha256 对不上：清单说 ${asset.sha256}，实际 ${actual}。` +
        '⛔ 已停在校验这一步，没有装载 —— 一份被改过的预制镜像会以平台身份跑每一个 Task',
    );
  }
}
