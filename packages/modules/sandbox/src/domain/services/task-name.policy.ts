/** How many code points of the instruction become the default name (P21-1 §9). */
export const TASK_NAME_MAX_CODE_POINTS = 20;
const ELLIPSIS = '…';

/**
 * Derive a Task's DEFAULT display name (P21-1 §9, 13 §2.1.1) — a pure domain policy.
 *
 * WHY THE BACKEND DERIVES IT: `initialPrompt` is never echoed on any DTO (裁决 D-14),
 * so the frontend cannot compute a name after a refresh. Deriving here once, at create
 * time, is what lets the instruction stay server-side without losing the display.
 * Once a user renames a task the platform never overwrites it again.
 *
 * ⚠️ CODE POINTS, NOT UTF-16 UNITS AND NOT DISPLAY WIDTH (25 T-SBX-9c): iterating the
 * string (`[...s]`) counts a CJK ideograph and an astral emoji as ONE each, whereas
 * `String.prototype.slice` would cut an astral character in half and produce a lone
 * surrogate. CJK counts as 1 character even though it renders double-width — the rule
 * is code points, deliberately, so the limit is stable and testable.
 */
export function deriveDefaultTaskName(input: {
  prompt?: string;
  /** Human-facing runtime label (adapter `displayName`, falling back to its id). */
  runtimeLabel: string;
  now: Date;
}): string {
  const fromPrompt = nameFromPrompt(input.prompt);
  if (fromPrompt !== undefined) return fromPrompt;
  // no instruction ⇒ `'Codex · 2026-08-10 14:23'` (10 §7.3). UTC on purpose: the
  // backend has no user time zone in the MVP, and a name must not silently differ
  // between the machine that wrote it and the one that reads it back.
  return `${input.runtimeLabel} · ${formatUtcMinute(input.now)}`;
}

function nameFromPrompt(prompt?: string): string | undefined {
  if (prompt === undefined) return undefined;
  const lines = prompt.split('\n');
  const index = lines.findIndex((l) => l.trim() !== '');
  if (index < 0) return undefined; // blank-only instruction ⇒ fall back to the label
  const line = lines[index].trim();
  const points = [...line];
  const truncated = points.length > TASK_NAME_MAX_CODE_POINTS;
  // more content was dropped when either the line itself was cut OR further non-blank
  // lines follow it — both mean the name does not show the whole instruction.
  const droppedMore = lines.slice(index + 1).some((l) => l.trim() !== '');
  const head = points.slice(0, TASK_NAME_MAX_CODE_POINTS).join('');
  return truncated || droppedMore ? `${head}${ELLIPSIS}` : head;
}

/** `YYYY-MM-DD HH:mm` in UTC. */
function formatUtcMinute(at: Date): string {
  const iso = at.toISOString(); // 2026-08-10T14:23:45.000Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
