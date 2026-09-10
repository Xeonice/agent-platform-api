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

/**
 * How many bytes BoxLite's layer cache holds right now — the raw number behind
 * `SandboxProvider.stageImage`'s `onProgress`.
 *
 * ── Why the filesystem and not the SDK ──────────────────────────────────────────
 * ⚠️ MEASURED 2026-09-10: the BoxLite SDK (0.9.7) exposes NO progress and NO
 * partial-size read — `ImageHandle` is exactly `{ pull, list }`, and `ImageInfo`
 * only carries `sizeBytes` for a COMPLETED image. Without this read, a pull of the
 * boxlite preset image (8 layers, 320MB compressed) is a silent bar; on a 273 KB/s
 * link that silence lasted 20 minutes.
 *
 * ⚠️ WHAT MAKES IT HONEST RATHER THAN A GUESS: the cache is one flat directory of
 * `sha256-<digest>.tar.gz` files, and `stat.size` on them matches the manifest's
 * layer sizes EXACTLY (verified: `sha256-0b90fc09….tar.gz` = 220_195_394 bytes =
 * the 210MB layer in the arm64 manifest). ⛔ `du` does NOT match — it reports
 * allocated blocks and ran 4.4% high (334MB vs 320MB). Sum `stat.size`, never `du`.
 *
 * ⚠️ IT IS A RUNNING TOTAL FOR THE WHOLE STORE, not for one image — that is the
 * contract (`bytesInStore`). Other images' layers are already there when the pull
 * starts; the CALLER subtracts its own baseline, so they cancel out.
 *
 * ⚠️ THIS READS BOXLITE'S PRIVATE LAYOUT, WHICH IS THE ONE THING TO REMEMBER ABOUT
 * IT. The path is not part of any published API and an upgrade may move it. ⇒ every
 * failure mode returns `null` (「I cannot measure」), never 0 (「nothing downloaded」):
 * a 0 would render as a bar that sits at 0% while bytes are visibly arriving, which
 * is exactly the 「wrong number is worse than a spinner」 case the contract warns of.
 */
export async function layerCacheBytes(
  home: string,
  fs: { readdir(p: string): Promise<string[]>; stat(p: string): Promise<{ size: number }> },
  join: (...parts: string[]) => string,
): Promise<number | null> {
  try {
    const dir = join(home, 'images', 'layers');
    const names = await fs.readdir(dir);
    let total = 0;
    for (const name of names) {
      // ⚠️ 单个文件读不到就跳过它，⛔ 不让整次测量失败：拉取过程中文件会被创建/改名，
      //    一次 ENOENT 是正常竞态，把它升级成「测不了」会让进度条无谓地消失。
      try {
        total += (await fs.stat(join(dir, name))).size;
      } catch {
        continue;
      }
    }
    return total;
  } catch {
    // 目录不存在（还没拉过任何镜像）也走这里 —— 那时确实「测不出增量基线」。
    return null;
  }
}
