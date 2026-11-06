import { constants } from 'node:os';
import { z } from 'zod';

// The outer call schema authenticates the envelope, not each method's payload.
// Preserve provider-owned extension keys and opaque cursors/raw observations.
const strings = z.record(z.string());
const command = {
  cmd: z.array(z.string()),
  env: strings.optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
  stdin: z.string().optional(),
};
export const OwnerProcessSpecSchema = z
  .object({
    ...command,
    tty: z.boolean(),
    cols: z.number().optional(),
    rows: z.number().optional(),
    user: z.string().optional(),
    reuse: z.string().optional(),
  })
  .passthrough();
export const OwnerJobSpecSchema = z.object(command).passthrough();
export const OwnerJobHandleSchema = z
  .object({ provider: z.string(), jobId: z.string() })
  .passthrough();
export const OwnerJobChunkSchema = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    cursor: z.string(),
    status: z.enum(['running', 'exited']),
    exitCode: z.number().optional(),
  })
  .passthrough();
export const OwnerJobReadOptionsSchema = z.object({ waitMs: z.number().optional() }).passthrough();
export const OwnerFileOptionsSchema = z
  .object({
    recursive: z.boolean().optional(),
    maxEntries: z.number().optional(),
  })
  .passthrough();
export const OwnerFileEntriesSchema = z.array(
  z
    .object({
      path: z.string(),
      kind: z.enum(['file', 'dir']),
      size: z.number().optional(),
      modifiedAt: z.string().optional(),
    })
    .passthrough(),
);
export const OwnerRuntimeStatusSchema = z
  .object({
    lifecycleState: z.enum([
      'instance_creating',
      'instance_running',
      'instance_paused',
      'instance_exited',
      'instance_dead',
      'instance_missing',
    ]),
    exitCode: z.number().optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
    resourceUsage: z.object({ cpuPercent: z.number(), ramUsedMb: z.number() }).optional(),
    health: z
      .object({
        state: z.enum(['healthy', 'unhealthy', 'unknown', 'starting']),
        lastCheckedAt: z.string(),
        message: z.string().optional(),
        consecutiveFailures: z.number(),
      })
      .optional(),
    raw: z.unknown().optional(),
  })
  .passthrough();
export const OwnerStopOptionsSchema = z.object({ timeoutSec: z.number().optional() }).passthrough();
export const OwnerBytesSchema = z.union([z.string(), z.instanceof(Buffer)]);
export function ownerSignal(value: unknown): NodeJS.Signals | undefined {
  if (value === undefined) return undefined;
  if (isSignal(value)) return value;
  throw new Error('Invalid owner signal');
}
function isSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === 'string' && Object.hasOwn(constants.signals, value);
}
export function ownerBytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string' || value instanceof Uint8Array) return Buffer.from(value);
  throw new Error('Invalid owner response bytes');
}
