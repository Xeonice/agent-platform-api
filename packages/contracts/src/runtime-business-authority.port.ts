import type { RuntimeOwnerFence } from './runtime-owner.contract';
import { RuntimeOwnerHandleSchema } from './runtime-owner.contract';
import { z } from 'zod';

export interface RuntimeBusinessOperation {
  /** A durable accepted operation, task/run or automation occurrence ID. */
  operationId: string;
  actor: RuntimeOwnerFence['actor'];
}
/** Local async context; the callback itself never crosses the owner RPC wire. */
export interface RuntimeBusinessAuthorityPort {
  run<T>(operation: RuntimeBusinessOperation, work: () => T): T;
  current?(): RuntimeBusinessOperation | undefined;
}
export const RUNTIME_BUSINESS_AUTHORITY = Symbol('RuntimeBusinessAuthority');
export const DurableAgentTaskStartSchema = z.object({
  version: z.literal(1),
  input: z.object({
    runtime: z.string().min(1),
    prompt: z.string(),
    timeoutMinutes: z.number().positive(),
    resumeFrom: z.string().optional(),
    extraArgs: z.array(z.string()).optional(),
  }),
  handle: RuntimeOwnerHandleSchema,
  spec: z
    .object({
      cmd: z.array(z.string()).min(1),
      env: z.record(z.string()).optional(),
      cwd: z.string().optional(),
      timeoutMs: z.number().positive().optional(),
      stdin: z.string().optional(),
    })
    .passthrough(),
  logPath: z.string().min(1),
  timeoutMs: z.number().positive(),
  operation: z.object({
    operationId: z.string().min(1),
    actor: z.object({ kind: z.enum(['user', 'automation', 'system']), id: z.string().min(1) }),
  }),
});
