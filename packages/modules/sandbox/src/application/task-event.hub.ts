import { Injectable } from '@nestjs/common';
import type { TaskEventBroadcaster, TaskServerFrame } from '@platform/contracts';

/** What a transport registers with the hub; called for every published frame. */
export type TaskFrameListener = (taskId: string, frame: TaskServerFrame) => void;

/**
 * Fan-out point for `/tasks` frames — the producer side of `TaskEventBroadcaster`.
 *
 * ── Why it exists instead of the gateway simply BEING the broadcaster ────────────
 * The gateway needs the application service (to replay a subscription from the log),
 * the service owns the workflow, and the workflow needs the broadcaster. Binding the
 * broadcaster token straight to the gateway closes that into a dependency CYCLE, and
 * the way it manifests is horrible: Nest does not report it, it simply never finishes
 * building the injector, so the app hangs at boot with no error to read.
 *
 * The hub cuts the cycle by depending on nothing: the workflow publishes INTO it, and
 * the gateway subscribes TO it, so neither has to know the other exists.
 *
 * It is deliberately dumb — no buffering, no retry, no ordering guarantees beyond
 * "listeners are called in registration order". Durability for this channel lives in
 * the platform's own JSONL log, which a subscriber replays from; paying for it twice
 * here is exactly the write amplification the `/tasks` channel was split out to avoid.
 */
@Injectable()
export class TaskEventHub implements TaskEventBroadcaster {
  private readonly listeners = new Set<TaskFrameListener>();

  publish(taskId: string, frame: TaskServerFrame): void {
    for (const listener of this.listeners) {
      try {
        listener(taskId, frame);
      } catch {
        // A broken transport must not stop a Task from running, and must not stop the
        // OTHER transports from hearing about it.
      }
    }
  }

  /** Register a transport. The returned function removes it again. */
  onFrame(listener: TaskFrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
