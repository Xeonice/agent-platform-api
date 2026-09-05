import type { Buffer } from 'node:buffer';

/**
 * 跨 registry 拷贝一张镜像 —— 搬运的第三条源（`upstream-copy`）。
 *
 * ── 为什么它值得单独存在 ────────────────────────────────────────────────────
 * 前两条源都要 docker：`local-docker` 从本机镜像库推，`release-asset` 要 `docker load`。
 * 而 **boxlite 档的宿主上可以根本没有 docker**（P21-5 §9F：macOS 走 Hypervisor.framework，
 * 不需要 Docker、不需要守护进程）。那样一台机器如果又没配资产清单，前两条源都不适用 ——
 * 此前 `plan()` 对这种情形如实返回 `build-only`「搬不了」，而它其实**只需要两个 HTTP 端点
 * 之间搬一次字节**。⇒ 这条路补上那一格。
 *
 * ⚠️ **纯 HTTP，不碰 docker**。这是它与另外两条源的全部区别，也是它存在的理由。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────────
 * ① **先问目标有没有，再决定推不推**：一层几百 MB，重推一遍是纯浪费，而 `HEAD` 一次几毫秒。
 * ② **每个 blob 取回来都验 sha256**（在 `fetchBlob` 里）：这些字节将以「平台预制镜像」的
 *    身份跑每一个 Task，一个改写响应体的中间层能让整条链在毫不知情的情况下换掉内容。
 * ③ **manifest 最后推**。它是这张镜像的「已就绪」信号 —— 先推 manifest 再推层，中途失败会
 *    在 registry 里留下一个**指向不存在的层**的 tag，而那比没有更糟：诊断会说就绪，
 *    拉取时才炸，且炸在每一个 Task 上。
 */

/** 拷贝需要的 registry 能力 —— 收窄到六个动作，替身不必扮演一整个 OCI 客户端。 */
export interface RegistryCopyPort {
  fetchRawManifest(
    name: string,
    reference: string,
  ): Promise<{ raw: Buffer; mediaType: string; digest: string }>;
  hasBlob(name: string, digest: string): Promise<boolean>;
  fetchBlob(name: string, digest: string): Promise<Buffer>;
  putBlob(name: string, digest: string, bytes: Buffer): Promise<void>;
  putManifest(name: string, reference: string, raw: Buffer, mediaType: string): Promise<void>;
}

export interface CopyProgress {
  (done: number, total: number, what: string): void;
}

/** manifest 里我们要读的那几格。 */
interface ManifestDoc {
  mediaType?: string;
  config?: { digest?: string };
  layers?: { digest?: string; size?: number }[];
  manifests?: {
    digest?: string;
    mediaType?: string;
    platform?: { os?: string; architecture?: string };
  }[];
}

/** index 里挑这台机器该用的那一份 —— 判据与 `OciRegistryClient.descend` 同源。 */
export function pickPlatformEntry(doc: ManifestDoc, arch: string): { digest: string } | null {
  const entries = (doc.manifests ?? []).filter(
    (m) => m.platform?.os !== 'unknown' && m.platform?.architecture !== 'unknown',
  );
  const want = arch === 'arm64' ? 'arm64' : 'amd64';
  const chosen =
    entries.find((m) => m.platform?.os === 'linux' && m.platform.architecture === want) ??
    entries.find((m) => m.platform?.os === 'linux') ??
    entries[0];
  return chosen?.digest === undefined ? null : { digest: chosen.digest };
}

const INDEX_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

export function isIndex(mediaType: string): boolean {
  return INDEX_TYPES.has(mediaType.split(';')[0]!.trim());
}

/**
 * 把 `from`（`name:tag`）拷到 `to`（`name:tag`）。
 *
 * ⚠️ **index 会被压平成单平台 manifest**，而不是原样搬整个 index：一个私有化单机部署只跑
 * 一种架构，搬另外几份是白搬几百 MB。⇒ 目标 tag 指向选中的那一份 —— 这对部署方也更好：
 * 「这个 tag 是哪一份 bits」从此没有歧义。
 */
export async function copyImage(
  reg: RegistryCopyPort,
  from: { name: string; reference: string },
  to: { name: string; reference: string },
  arch: string,
  onProgress: CopyProgress = () => undefined,
): Promise<{ digest: string; layers: number; skipped: number }> {
  let { raw, mediaType, digest } = await reg.fetchRawManifest(from.name, from.reference);
  let doc = JSON.parse(raw.toString('utf8')) as ManifestDoc;

  if (isIndex(mediaType)) {
    const entry = pickPlatformEntry(doc, arch);
    if (entry === null) {
      throw new Error(`'${from.name}:${from.reference}' 的 index 里没有可用平台（要 ${arch}）`);
    }
    ({ raw, mediaType, digest } = await reg.fetchRawManifest(from.name, entry.digest));
    doc = JSON.parse(raw.toString('utf8')) as ManifestDoc;
  }

  // config 与 layers 一起搬 —— config 也是一个 blob，漏了它 manifest 推上去也拉不动。
  const blobs = [
    ...(doc.config?.digest === undefined ? [] : [doc.config.digest]),
    ...(doc.layers ?? []).flatMap((l) => (l.digest === undefined ? [] : [l.digest])),
  ];

  let done = 0;
  let skipped = 0;
  for (const d of blobs) {
    // ① 目标已有就跳过 —— 一层几百 MB，重推是纯浪费。
    if (await reg.hasBlob(to.name, d)) {
      skipped += 1;
      done += 1;
      onProgress(done, blobs.length, `已存在 ${short(d)}`);
      continue;
    }
    onProgress(done, blobs.length, `拉取 ${short(d)}`);
    const bytes = await reg.fetchBlob(from.name, d); // ② 取回即验 sha256
    onProgress(done, blobs.length, `推送 ${short(d)}`);
    await reg.putBlob(to.name, d, bytes);
    done += 1;
    onProgress(done, blobs.length, `完成 ${short(d)}`);
  }

  // ③ manifest 最后推：它是「已就绪」的信号，先推它会在失败时留下一个指向不存在的层的 tag。
  await reg.putManifest(to.name, to.reference, raw, mediaType);
  return { digest, layers: blobs.length, skipped };
}

function short(digest: string): string {
  return digest.replace('sha256:', '').slice(0, 12);
}
