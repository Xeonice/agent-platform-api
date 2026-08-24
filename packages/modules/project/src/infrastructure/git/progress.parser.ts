import type { CloneProgress, CloneStage } from '../../domain/ports/git-cloner.port';

/**
 * Parse `git clone --progress` stderr (docs/backend/03 §7.2). git rewrites the same
 * line with `\r`, so fragments are split on CR/LF.
 *
 * ★ 2026-08: this used to match ONLY `Receiving objects` and to capture only
 * `percent` + received bytes. Two things were wrong with that, both surfaced by a
 * real clone (flask, 26348 objects) once 03 §7.2★ turned shallow clones into full
 * ones:
 *
 *  ① **The object counts were matched and thrown away.** `(527/26348)` sat in a
 *     NON-capturing group. That pair is the only honest denominator git gives us —
 *     see the note on `totalBytes` in `CloneProgress`.
 *  ② **Speed was never matched at all.** `| 189.00 KiB/s` is the single most direct
 *     answer to "is this thing moving or wedged": it drops to zero long before the
 *     percentage visibly stops advancing.
 *
 * We now track every stage git announces. Measured share of a real clone:
 * enumerate/count/compress 0.1%, **receiving 93.7%**, resolving 0.3% — so receiving
 * still dominates and remains the bar's driver. The other stages earn their place by
 * covering the ~3.4s (much longer on a slow remote) BEFORE receiving starts, during
 * which the old parser produced literally nothing and the UI showed a bare pulse.
 */
const STAGE_PATTERNS: readonly { stage: CloneStage; re: RegExp }[] = [
  // `remote: Enumerating objects: 26348, done.` — a bare total, no percent.
  { stage: 'enumerating', re: /Enumerating objects:\s+(?<total>\d+)/ },
  {
    stage: 'counting',
    re: /Counting objects:\s+(?<percent>\d+)%\s+\((?<done>\d+)\/(?<total>\d+)\)/,
  },
  {
    stage: 'compressing',
    re: /Compressing objects:\s+(?<percent>\d+)%\s+\((?<done>\d+)\/(?<total>\d+)\)/,
  },
  {
    stage: 'receiving',
    re: /Receiving objects:\s+(?<percent>\d+)%\s+\((?<done>\d+)\/(?<total>\d+)\)(?:,\s+(?<bytes>[\d.]+)\s+(?<unit>B|KiB|MiB|GiB))?(?:\s+\|\s+(?<rate>[\d.]+)\s+(?<rateUnit>B|KiB|MiB|GiB)\/s)?/,
  },
  {
    stage: 'resolving',
    re: /Resolving deltas:\s+(?<percent>\d+)%\s+\((?<done>\d+)\/(?<total>\d+)\)/,
  },
  // Checkout of a large working tree; only shows up on repos with many files.
  { stage: 'checkout', re: /Updating files:\s+(?<percent>\d+)%\s+\((?<done>\d+)\/(?<total>\d+)\)/ },
];

const UNIT_BYTES: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 * 1024,
  GiB: 1024 * 1024 * 1024,
};

function toBytes(value: string | undefined, unit: string | undefined): number | undefined {
  if (value === undefined || unit === undefined) return undefined;
  return Math.round(Number(value) * (UNIT_BYTES[unit] ?? 1));
}

function toInt(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

/**
 * Latest progress in a stderr fragment, or null if it carries no recognisable stage
 * line. "Latest" and not "first": git packs many `\r`-separated updates into one
 * chunk, and only the last one is still true by the time we read it.
 */
export function parseCloneProgress(fragment: string): CloneProgress | null {
  let latest: CloneProgress | null = null;
  for (const line of fragment.split(/[\r\n]+/)) {
    for (const { stage, re } of STAGE_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const g = m.groups ?? {};
      latest = {
        stage,
        percent: toInt(g.percent),
        objectsDone: toInt(g.done),
        objectsTotal: toInt(g.total),
        receivedBytes: toBytes(g.bytes, g.unit),
        bytesPerSecond: toBytes(g.rate, g.rateUnit),
      };
      break;
    }
  }
  return latest;
}
