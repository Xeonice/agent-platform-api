import { parseImageRef, pinnedImageRef, type ResolvedImageSpec } from '@platform/contracts';

/**
 * The one field of BoxLite's `ImageInfo` this file reads. Narrowed to a structural
 * type on purpose: the matcher below must be runnable in a UNIT test on Linux CI,
 * where the native BoxLite binary does not exist and `ImageInfo` cannot be imported
 * without dragging the SDK in.
 */
export interface StagedImageEntry {
  readonly reference: string;
}

/**
 * Is the image the platform is about to run ALREADY in BoxLite's local store?
 *
 * ── Why this is a string comparison and not a digest comparison ──────────────────
 * ⚠️ MEASURED AGAINST THE REAL STORE (`~/.boxlite/db/boxlite.db`, `image_index`,
 * 2026-08-28) rather than guessed, because two plausible-looking keys are both WRONG:
 *
 *   · `manifest_digest` — the row for `localhost:5001/platform/sandbox:v2@sha256:ee84dd…`
 *     carries `manifest_digest = sha256:25645ad6…`. They DIFFER: the digest inside the
 *     reference is the multi-arch index digest the platform pinned, the column holds the
 *     per-arch manifest it resolved to. Matching on it never hits.
 *   · `repository`/`tag` — for a digest-pinned pull the whole `name:tag@sha256:…` string
 *     IS the primary key, so there is no clean tag half to compare.
 *
 * What the store actually keys on is the reference string it was HANDED, verbatim —
 * and the string the platform hands it is exactly `pinnedImageRef(spec)` (04 §7 时刻④,
 * `BoxliteSandboxProvider.create`). So the honest test is: is that same string a row?
 *
 * ── The one normalisation, and why it is only needed on the degraded path ────────
 * A pull by BARE TAG is normalised into the row: `alpine:latest` is stored as
 * `docker.io/library/alpine:latest`, `alpine/git:latest` as `docker.io/alpine/git:latest`
 * (both verbatim from the same table). `pinnedImageRef` degrades to a bare tag only for
 * a PRE-SLICE sandbox row whose digest was never resolved, so that path is rare — but
 * skipping the normalisation there would report 「本机没有」 for an image that is sitting
 * right there, i.e. the answer would be wrong exactly for the oldest sandboxes.
 *
 * ⚠️ A NEGATIVE IS THE SAFE DIRECTION AND THE COPY DEPENDS ON THAT. `complete` (0 for an
 * interrupted pull) is a column BoxLite's `images.list()` selects but does NOT expose on
 * `ImageInfo`, so a half-pulled 13GB image still lists and this function still answers
 * `true`. That is the one false positive it cannot rule out — which is why the frontend
 * copy for `true` states a FACT (「镜像已在本机」) and never a promise about how long the
 * start will take. Being wrong then costs the user a missing reassurance, not a broken one.
 */
export function isImageStaged(
  entries: readonly StagedImageEntry[],
  image: Pick<ResolvedImageSpec, 'ref' | 'digest'>,
): boolean {
  const wanted = pinnedImageRef(image);
  const normalised = normaliseStoreReference(wanted);
  return entries.some((e) => e.reference === wanted || e.reference === normalised);
}

/**
 * `alpine` → `docker.io/library/alpine:latest` — the form BoxLite records for a pull
 * that named no registry (standard OCI defaulting, confirmed against the live table).
 *
 * A reference that already carries a digest is returned untouched: the store keeps
 * those verbatim, and 「补一个 docker.io/」 on top of a pinned localhost mirror ref
 * would manufacture a string that matches nothing.
 */
export function normaliseStoreReference(ref: string): string {
  if (ref.includes('@')) return ref;
  const { name, tag } = parseImageRef(ref);
  const firstSegment = name.split('/')[0] ?? '';
  // A registry host is the only first segment that can contain a dot or a port; the
  // bare `localhost` special case is the one that has neither (and is the local mirror
  // this repo's boxlite path actually uses).
  const hasRegistry = firstSegment.includes('.') || firstSegment.includes(':');
  if (hasRegistry || firstSegment === 'localhost') return `${name}:${tag ?? 'latest'}`;
  const qualified = name.includes('/') ? name : `library/${name}`;
  return `docker.io/${qualified}:${tag ?? 'latest'}`;
}

/** 一张镜像的铺开进度：`have` = 这张镜像的层已经落盘多少字节，`total` = 它一共多少。 */
export interface ImageStageProgress {
  have: number;
  total: number;
}

/**
 * 按**这张镜像自己的清单**量进度。⛔ 取代 `layerCacheBytes` + 调用方减基线那一套。
 *
 * ── 为什么换掉基线法（2026-09-14 真机打脸）─────────────────────────────────────
 * 旧算法是 `本次新落盘 = 当前全店字节 − 调用开始时的全店字节`。它只在缓存**单调增长**
 * 时成立，而实测并不是：153 KB/s 的链路上，那个 210MB 的大层下到一半就断，boxlite
 * **把半截层删掉重来** —— `images/layers` 从 157MB 掉回 112MB（文件 8 → 7）。
 * 于是 `当前 − 基线` 变成负数，被 `Math.max(0, …)` 钉死在 **0**：界面显示「已下载 2MB ·
 * 1%」，而磁盘上其实已经有 8 层里的 7 层、109.8MB / 319.8MB ≈ **34%**，
 * 「已用时长」还在往上跳 22 分钟。用户看到的是「一直在反复跑」。
 *
 * ⚠️ 还有一处口径不一致：分子是「本次新落盘」，分母却是**整张镜像**。续传时已缓存的部分
 * 被分子排除、却仍留在分母里 —— 即使一切正常也会显示接近 0%。
 *
 * ── 新算法为什么是对的 ────────────────────────────────────────────────────────
 * 清单里每一层都有 `digest` 与 `size`，而磁盘上层文件正是按同一个 digest 命名
 * （`sha256-<digest>.tar.gz`）。⇒ **分子分母同源**：
 *   · `total` = 清单里所有层的 size 之和（= 那个「约 320MB」）
 *   · `have`  = 这些 digest 在磁盘上实际占了多少（`stat.size`）
 *
 * ⚠️ **正在下的那一层也算得进去**：boxlite 把半截层直接写在 `layers/` 里、用最终 digest
 * 命名（实测：下载中文件数是 8，丢弃后变 7）。所以进度是**平滑**的，不是一层一跳。
 * ⛔ 这一点很要紧 —— 那个 210MB 的层占全量 66%，一层一跳的话它会在 34% 停二十分钟。
 *
 * ⚠️ **丢层时 `have` 会下降，这是如实反映，不是 bug**：它恰好告诉用户「刚才那一层白下了」，
 * 而旧算法把这件事伪装成「卡在 1%」。⛔ 不要在这里加"只增不减"的钳制。
 *
 * ⚠️ 任何一步测不出来都返回 `null`（「我量不了」），⛔ 不返回 0（「什么都没下」）——
 * 与本文件既有纪律一致：一个错的数比一个转圈更糟。
 */
export async function imageStageProgress(
  home: string,
  manifestDigest: string,
  platformArch: string,
  fs: {
    readFile(p: string, enc: 'utf8'): Promise<string>;
    stat(p: string): Promise<{ size: number }>;
  },
  join: (...parts: string[]) => string,
): Promise<ImageStageProgress | null> {
  const manifestPath = (digest: string): string =>
    join(home, 'images', 'manifests', `${digest.replace(':', '-')}.json`);

  const readManifest = async (digest: string): Promise<Record<string, unknown> | null> => {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(manifestPath(digest), 'utf8'));
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  let doc = await readManifest(manifestDigest);
  if (doc === null) return null;

  // ⚠️ 多架构 index：顶层只有 `manifests`，真正的层清单在**本机架构**那一份里。
  //    ⛔ 不许随便取第一个 —— amd64 与 arm64 的层完全不同，取错了分母就是错的。
  const children = doc['manifests'];
  if (Array.isArray(children)) {
    const match = children.find((m): m is Record<string, unknown> => {
      if (typeof m !== 'object' || m === null) return false;
      const p = (m as Record<string, unknown>)['platform'];
      return (
        typeof p === 'object' &&
        p !== null &&
        (p as Record<string, unknown>)['architecture'] === platformArch
      );
    });
    if (match === undefined) return null;
    const childDigest = match['digest'];
    if (typeof childDigest !== 'string') return null;
    doc = await readManifest(childDigest);
    if (doc === null) return null;
  }

  const layers = doc['layers'];
  if (!Array.isArray(layers) || layers.length === 0) return null;

  let total = 0;
  let have = 0;
  for (const raw of layers) {
    if (typeof raw !== 'object' || raw === null) return null;
    const layer = raw as Record<string, unknown>;
    const digest = layer['digest'];
    const size = layer['size'];
    if (typeof digest !== 'string' || typeof size !== 'number') return null;
    total += size;
    try {
      const onDisk = await fs.stat(
        join(home, 'images', 'layers', `${digest.replace(':', '-')}.tar.gz`),
      );
      // ⚠️ 半截层的 `stat.size` 就是"已经写进去多少"，直接用。
      //    ⛔ 钳到 `size` 是必要的：极少数情况下落盘会略多于清单声称的量，
      //       而一个 >100% 的读数会让人以为进度是坏的。
      have += Math.min(onDisk.size, size);
    } catch {
      // 这一层还没开始下 —— 不是错误，计 0。
      continue;
    }
  }
  return { have, total };
}
