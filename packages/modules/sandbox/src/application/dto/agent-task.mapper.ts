import { Logger } from '@nestjs/common';
import { TaskErrorCodeSchema, TaskTimeoutMinutesSchema } from '@platform/contracts';
import type { AgentTaskDto, TaskErrorCode, TaskStatus } from '@platform/contracts';
import type { AgentTask } from '../../domain/entities/agent-task.entity';

const logger = new Logger('AgentTaskMapper');

/** The four tiers, ascending — the only values `timeoutMinutes` may take on the wire. */
const TIERS = [30, 60, 120, 240] as const;

/**
 * Map a stored budget onto a wire tier WITHOUT throwing.
 *
 * ⚠️ IT USED TO BE `TaskTimeoutMinutesSchema.parse`, AND THAT MADE ONE BAD ROW FATAL
 * FOR THE WHOLE LISTING. This mapper runs per row inside `GET /api/sandboxes/:id/tasks`,
 * so a single row holding a value the tiers do not cover (an older row, a hand-edited
 * DB, a tier removed in a later release) took down every OTHER task's history with it —
 * exactly when a user is trying to find out what happened. The anomaly is still
 * reported, it just no longer decides whether 200 rows are visible.
 */
function toTier(timeoutMs: number): (typeof TIERS)[number] {
  const minutes = Math.round(timeoutMs / 60_000);
  const exact = TaskTimeoutMinutesSchema.safeParse(minutes);
  if (exact.success) return exact.data;
  logger.error(`agent task has a non-tier timeout of ${minutes}min; reporting the nearest tier`);
  return TIERS.find((t) => t >= minutes) ?? 240;
}

/**
 * Same discipline for the error code: the enum is the closed set the backend produces,
 * so anything else is a bug — reported loudly, and reported as `INTERNAL` rather than
 * as a 500 that hides the other rows.
 */
function toErrorCode(code: string): TaskErrorCode {
  const parsed = TaskErrorCodeSchema.safeParse(code);
  if (parsed.success) return parsed.data;
  logger.error(`agent task carries an unknown errorCode '${code}'; reporting INTERNAL`);
  return 'INTERNAL';
}

/**
 * Domain aggregate → wire DTO (28 §4 boundary rule).
 *
 * The domain's `AgentTaskStatus` and the contract's `TaskStatus` are deliberately two
 * declarations of the same five values — the domain layer may not import contracts
 * (01 §3) — so this is where the two meet. The compile-time assertion below is what
 * keeps them from drifting: add a state on one side and this file stops typechecking.
 *
 * Nothing here is optional-by-accident: `exitCode`, `sessionRef`, `errorCode` and
 * `finishedAt` are ABSENT rather than null when they have no value, because the wire
 * contract says "may be absent" and a null would make every consumer write two checks.
 */
export const AgentTaskMapper = {
  toDto(task: AgentTask): AgentTaskDto {
    const status: TaskStatus = task.status;
    return {
      id: task.id,
      sandboxId: task.sandboxId,
      runtime: task.runtime,
      status,
      ...(task.exitCode !== null ? { exitCode: task.exitCode } : {}),
      ...(task.sessionRef !== null ? { sessionRef: task.sessionRef } : {}),
      // The aggregate stores milliseconds (that is what `JobSpec.timeoutMs` wants); the
      // wire speaks tiers. Validated rather than cast — the four tiers are an invariant
      // enforced at the door — but NOT by throwing: see `toTier`.
      timeoutMinutes: toTier(task.timeoutMs),
      lastSeq: task.lastSeq,
      artifacts: task.artifacts.map((a) => ({
        name: a.name,
        size: a.size,
        modifiedAt: a.modifiedAt,
      })),
      ...(task.errorCode !== null ? { errorCode: toErrorCode(task.errorCode) } : {}),
      startedAt: task.startedAt.toISOString(),
      ...(task.finishedAt !== null ? { finishedAt: task.finishedAt.toISOString() } : {}),
    };
  },
};
