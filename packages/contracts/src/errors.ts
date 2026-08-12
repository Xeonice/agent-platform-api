import { z } from 'zod';

/**
 * Unified error envelope (docs/backend/04 §4, shared/10 §6.8, 02 §6).
 * Non-2xx REST bodies and MCP tool errors both carry this shape.
 * `retryable` is a first-class field — the frontend renders [retry] off it,
 * not off the HTTP status code. `code` is NEVER absent (fallback 'INTERNAL').
 */
export const ErrorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  traceId: z.string().optional(),
  details: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export const INTERNAL_ERROR_CODE = 'INTERNAL';
