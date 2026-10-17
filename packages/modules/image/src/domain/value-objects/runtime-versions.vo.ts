/** Optional build declarations, never proof that a CLI exists in a running Guest. */
const RUNTIME_IDS = ['codex', 'claude-code'] as const;
const NUMERIC = '(0|[1-9][0-9]*)';
const PRERELEASE = '(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)';
const EXACT_VERSION = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE}(?:\\.${PRERELEASE})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
);

/** Untrusted/missing metadata degrades to unknown without blocking image registration. */
export function normalizeRuntimeVersions(input: unknown): Record<string, string> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  const result: Record<string, string> = {};
  for (const id of RUNTIME_IDS) {
    if (!Object.prototype.hasOwnProperty.call(input, id)) continue;
    const value = (input as Record<string, unknown>)[id];
    if (
      typeof value === 'string' &&
      value.length <= 128 &&
      value === value.trim() &&
      EXACT_VERSION.test(value)
    ) {
      result[id] = value;
    }
  }
  return result;
}

export function parseRuntimeVersionsLabel(label: unknown): Record<string, string> {
  if (typeof label !== 'string' || label.length > 4096) return {};
  try {
    return normalizeRuntimeVersions(JSON.parse(label));
  } catch {
    return {};
  }
}
