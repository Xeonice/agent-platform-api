import type { TaskServerFrame } from './ws-protocol';

/**
 * Broadcaster port for the `/tasks` channel (S6; ws-protocol `TaskServerFrame`).
 *
 * ── Why it is a SEPARATE port from `SandboxEventBroadcaster` ─────────────────────
 * Not symmetry — different delivery semantics. `/events` frames are business
 * projections that ride the outbox for at-least-once delivery; task output is a
 * high-volume BYTE-DERIVED stream where a long run emits thousands of frames. Pushing
 * those through the same port would make the two share a fan-out that only one of them
 * can afford, and would drown the projection channel the whole UI depends on.
 *
 * ── Delivery is BEST EFFORT, and that is safe here ───────────────────────────────
 * A dropped frame is recoverable in a way a dropped projection is not: every event has
 * a dense `seq`, and the platform's own JSONL log can replay from any `fromSeq`. So a
 * subscriber that missed something asks for it again instead of the platform paying
 * for durability twice.
 *
 * ⚠️ The implementation MUST NOT be the websocket gateway itself. The gateway needs the
 * application service (to replay a subscription out of the log), the service owns the
 * workflow, and the workflow needs this port — binding the token to the gateway closes
 * that into a dependency cycle whose symptom is an injector that never finishes
 * building, with no error printed. A standalone fan-out hub cuts it.
 */
export interface TaskEventBroadcaster {
  /** Fan out one frame to everyone subscribed to `taskId`. */
  publish(taskId: string, frame: TaskServerFrame): void;
}

export const TASK_EVENT_BROADCASTER = Symbol('TaskEventBroadcaster');
