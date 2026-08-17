import type { CloneProgress } from '../../domain/ports/git-cloner.port';

/**
 * Parse `git clone --progress` stderr (docs/backend/03 §7.2). git updates the
 * same line with `\r`, so fragments are split on CR/LF. We track the dominant
 * "Receiving objects" stage: percent (0-100) + received bytes when git reports
 * a size (e.g. "Receiving objects:  45% (450/1000), 5.10 MiB | 2.0 MiB/s").
 */
const RECEIVING =
  /Receiving objects:\s+(\d+)%(?:\s+\(\d+\/\d+\))?(?:,\s+([\d.]+)\s+(B|KiB|MiB|GiB))?/;

const UNIT_BYTES: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 * 1024,
  GiB: 1024 * 1024 * 1024,
};

/** Latest progress in a stderr fragment, or null if it carries no receiving line. */
export function parseCloneProgress(fragment: string): CloneProgress | null {
  let latest: CloneProgress | null = null;
  for (const line of fragment.split(/[\r\n]+/)) {
    const m = RECEIVING.exec(line);
    if (!m) continue;
    const percent = Number(m[1]);
    const receivedBytes =
      m[2] && m[3] ? Math.round(Number(m[2]) * (UNIT_BYTES[m[3]] ?? 1)) : undefined;
    latest = { percent, receivedBytes };
  }
  return latest;
}
