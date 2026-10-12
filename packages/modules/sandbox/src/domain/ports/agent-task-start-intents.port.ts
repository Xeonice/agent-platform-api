import type { Tx } from '@platform/shared-kernel';

/** A durable command reservation preceding any guest start side effect. */
export interface AgentTaskStartIntent {
  taskId: string;
  sandboxId: string;
  provider: string;
  payload: string;
  createdAt: Date;
}
export interface AgentTaskStartIntents {
  find(taskId: string): Promise<AgentTaskStartIntent | null>;
  createSync(tx: Tx, intent: AgentTaskStartIntent): void;
  completeSync(tx: Tx, taskId: string): void;
  pending(): Promise<AgentTaskStartIntent[]>;
}
export const AGENT_TASK_START_INTENTS = Symbol('AgentTaskStartIntents');
