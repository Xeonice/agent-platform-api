/**
 * Lifecycle of a headless agent run (S6). The wire mirror is `TaskStatusSchema` in
 * the contracts package; this copy exists because the DOMAIN layer may not import
 * contracts (01 §3 dependency direction) — the application layer maps between them.
 *
 * `killed` and `timed_out` are separate on purpose: the first is a person deciding to
 * stop, the second is the platform's hard-timeout backstop firing (03 §8.3). Folding
 * them into `failed` would erase the only signal that tells an operator whether the
 * timeout tier is too small or the agent is genuinely broken.
 */
export const TASK_STATUSES = ['running', 'succeeded', 'failed', 'killed', 'timed_out'] as const;

export type AgentTaskStatus = (typeof TASK_STATUSES)[number];

const TERMINAL: ReadonlySet<AgentTaskStatus> = new Set<AgentTaskStatus>([
  'succeeded',
  'failed',
  'killed',
  'timed_out',
]);

export function isTerminalTaskStatus(status: AgentTaskStatus): boolean {
  return TERMINAL.has(status);
}

/**
 * The verdict for a job that exited on its own.
 *
 * ⚠️ AN ABSENT EXIT CODE COUNTS AS FAILURE, NOT AS "still running" — a process killed
 * by a signal has no ordinary exit code (`JobChunk.exitCode` carries the same
 * discipline). And 124 is the platform's agreed spelling of "the sandbox-side hard
 * timeout killed it" (03 §8.3), which is why it maps to `timed_out` rather than to a
 * generic failure.
 */
export function verdictFromExitCode(exitCode: number | undefined): AgentTaskStatus {
  if (exitCode === 0) return 'succeeded';
  if (exitCode === 124) return 'timed_out';
  return 'failed';
}
