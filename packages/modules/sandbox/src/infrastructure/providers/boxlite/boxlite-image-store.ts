import {
  isOciDigest,
  parseImageRef,
  pinnedImageRef,
  type ResolvedImageSpec,
} from '@platform/contracts';

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
  fs: StoreReader & {
    stat(p: string): Promise<{ size: number }>;
  },
  join: (...parts: string[]) => string,
): Promise<ImageStageProgress | null> {
  const doc = await readPlatformManifest(home, manifestDigest, platformArch, fs, join);
  if (doc === null) return null;

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

/** 读 BoxLite 本地库只需要这一只手；注入进来，离线单测才跑得通（与 `imageStageProgress` 同理）。 */
export interface StoreReader {
  readFile(p: string, enc: 'utf8'): Promise<string>;
}

/** 本地库里一份 JSON（manifest / config）：读不到、不是对象 ⇒ `null`。 */
async function readStoreJson(
  fs: StoreReader,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 库里的文件按 digest 命名，`:` 换成 `-`（`sha256-<hex>.json`）。 */
function storeFileName(digest: string): string {
  return `${digest.replace(':', '-')}.json`;
}

/**
 * 按 digest 读出**本机架构**的那份 manifest（层清单 + config 指针）。
 * 从 `imageStageProgress` 抽出来，供 {@link imageExposedPorts} 共用 —— 下钻规则只该有一份。
 *
 * ⚠️ 多架构 index：顶层只有 `manifests`，真正的层清单在**本机架构**那一份里。
 *    ⛔ 不许随便取第一个 —— amd64 与 arm64 的层完全不同，取错了分母就是错的。
 */
export async function readPlatformManifest(
  home: string,
  manifestDigest: string,
  platformArch: string,
  fs: StoreReader,
  join: (...parts: string[]) => string,
): Promise<Record<string, unknown> | null> {
  const manifestPath = (digest: string): string =>
    join(home, 'images', 'manifests', storeFileName(digest));

  const doc = await readStoreJson(fs, manifestPath(manifestDigest));
  if (doc === null) return null;

  const children = doc['manifests'];
  if (!Array.isArray(children)) return doc;
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
  return readStoreJson(fs, manifestPath(childDigest));
}

/** 镜像 config 里 `ExposedPorts` 的一项。 */
export interface ExposedPort {
  port: number;
  protocol: 'tcp' | 'udp';
}

/**
 * 镜像自己声明了哪些端口（OCI config 的 `config.ExposedPorts`）—— BoxLite 按的就是这份
 * 决定自动发布什么（它日志里 `Port mappings: N (image: M, …)` 的 M），读它就是读事实。
 *
 * ── 为什么读 BoxLite 的私有目录 ───────────────────────────────────────────────
 * SDK 0.9.7 的 `images` 只有 `pull` 与 `list`，`ImageInfo` 不带 config；平台注册镜像时
 * 也没有把 `ExposedPorts` 落库。路径：manifest（多架构时按本机架构下钻）→ `config.digest`
 * → `images/configs/sha256-<hex>.json`。
 *
 * ── 三种答案，⛔ 不许混 ─────────────────────────────────────────────────────────
 *   · `[]`   —— 镜像**明确没有**声明端口（`config` 或 `ExposedPorts` 缺席 / 为 null）。
 *   · 非空   —— 声明了这些端口（同一端口写两遍只算一次；不带协议的按 tcp，与 BoxLite 同口径）。
 *   · `null` —— **读不到**，不等于没有：manifest / config 不在库里、JSON 坏了、index 里
 *               没有本机架构、或者某个键不是 `<1-65535>[/tcp|/udp]`（`8000-8010/tcp` 这种
 *               区间写法也算）。不认识的形状一律不猜。
 */
export async function imageExposedPorts(
  home: string,
  manifestDigest: string,
  platformArch: string,
  fs: StoreReader,
  join: (...parts: string[]) => string,
): Promise<ExposedPort[] | null> {
  const manifest = await readPlatformManifest(home, manifestDigest, platformArch, fs, join);
  if (manifest === null) return null;
  const pointer = manifest['config'];
  if (typeof pointer !== 'object' || pointer === null) return null;
  const configDigest = (pointer as Record<string, unknown>)['digest'];
  // ⚠️ 校验 digest 形状再拼路径：这个值来自磁盘上的 JSON，不是平台自己算的。
  if (typeof configDigest !== 'string' || !isOciDigest(configDigest)) return null;

  const blob = await readStoreJson(
    fs,
    join(home, 'images', 'configs', storeFileName(configDigest)),
  );
  if (blob === null) return null;
  const config = blob['config'];
  if (config === undefined || config === null) return [];
  if (typeof config !== 'object' || Array.isArray(config)) return null;
  const exposed = (config as Record<string, unknown>)['ExposedPorts'];
  if (exposed === undefined || exposed === null) return [];
  if (typeof exposed !== 'object' || Array.isArray(exposed)) return null;

  const ports: ExposedPort[] = [];
  for (const key of Object.keys(exposed)) {
    const parsed = parseExposedPortKey(key);
    if (parsed === null) return null;
    if (!ports.some((p) => p.port === parsed.port && p.protocol === parsed.protocol)) {
      ports.push(parsed);
    }
  }
  return ports;
}

const EXPOSED_PORT_KEY = /^([1-9][0-9]{0,4})(?:\/(tcp|udp))?$/;

function parseExposedPortKey(key: string): ExposedPort | null {
  const match = EXPOSED_PORT_KEY.exec(key);
  if (match === null) return null;
  const port = Number(match[1]);
  if (port > 65_535) return null;
  return { port, protocol: match[2] === 'udp' ? 'udp' : 'tcp' };
}
