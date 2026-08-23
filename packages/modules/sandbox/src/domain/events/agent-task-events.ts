import type { AgentTaskId, DomainEvent, SandboxId } from '@platform/shared-kernel';
import type { AgentTaskStatus } from '../value-objects/agent-task-status.vo';

/**
 * Domain events for the headless Task aggregate (23 §12: DOMAIN names, not WS
 * projection names — the WS frame is a projection, never 1:1).
 *
 * ⚠️ `AgentTaskStarted` IS THE AUDIT RECORD, and that is the whole reason it exists
 * as a domain event rather than a log line. S6 is the first time this platform lets
 * an outside caller EXECUTE something: before it, REST and MCP could only create,
 * list and destroy sandboxes. Every start therefore rides the outbox in the SAME
 * transaction as the row (28 §7.3 R-3), so "who asked for what to run, and when"
 * cannot be lost by a crash between the two writes, and cannot be silently skipped
 * by a future caller that forgets to log.
 *
 * The prompt is NOT carried: it can be up to 8000 characters of user content and the
 * event stream is not where it belongs (the sandbox row already stores instructions —
 * 13 §2.1.1). What the audit needs is the identity of the run, the sandbox it entered
 * and the runtime it drove.
 */
export class AgentTaskStarted implements DomainEvent {
  readonly type = 'AgentTaskStarted';
  constructor(
    readonly taskId: AgentTaskId,
    readonly sandboxId: SandboxId,
    readonly runtime: string,
    /** Present ⇒ this is a CONTINUATION of an existing CLI conversation (04 §3 ★4). */
    readonly resumedFrom: string | undefined,
    readonly occurredAt: Date,
  ) {}
}

export class AgentTaskFinished implements DomainEvent {
  readonly type = 'AgentTaskFinished';
  constructor(
    readonly taskId: AgentTaskId,
    readonly sandboxId: SandboxId,
    readonly status: AgentTaskStatus,
    /** MAY be absent — a signal-killed process has no ordinary exit code. */
    readonly exitCode: number | undefined,
    readonly occurredAt: Date,
  ) {}
}
