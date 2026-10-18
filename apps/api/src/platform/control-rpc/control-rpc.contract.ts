import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { z } from 'zod';

export const ApplicationRequestSchema = z
  .object({
    operation: z.string().min(1).max(180),
    operationId: z.string().min(1).max(180),
    args: z.array(z.unknown()).max(16),
    request: z
      .object({
        method: z.string().max(16),
        path: z.string().max(2048),
        headers: z.record(z.union([z.string(), z.array(z.string())])),
        query: z.record(z.unknown()),
        remoteAddress: z.string().max(128),
      })
      .strict(),
  })
  .strict();
export type ApplicationRequest = z.infer<typeof ApplicationRequestSchema>;
export const ApplicationOperationSchema = z.object({
  operationId: z.string(),
  state: z.enum(['absent', 'pending', 'complete', 'unknown']),
  resultAvailable: z.boolean(),
  result: z.unknown().optional(),
  observedAt: z.string().datetime(),
});
export interface ApplicationRoute {
  operation: string;
  path: string;
  verb: string;
  status: number;
  args: { index: number; type: RouteParamtypes; name?: string; passthrough?: boolean }[];
}
export type ApplicationFrame =
  | { type: 'headers'; status: number; headers: Record<string, string | number | string[]> }
  | { type: 'result'; value?: unknown }
  | { type: 'bytes'; data: string }
  | { type: 'error'; code: string }
  | { type: 'complete' };
export interface ApplicationCatalog {
  protocol: { min: number; max: number };
  routes: ApplicationRoute[];
  tools: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    operation: string;
  }[];
}

/** Private transport is still an external input boundary after serialization. */
export const ApplicationFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('headers'),
    status: z.number().int(),
    headers: z.record(z.union([z.string(), z.number(), z.array(z.string())])),
  }),
  z.object({ type: z.literal('result'), value: z.unknown().optional() }),
  z.object({ type: z.literal('bytes'), data: z.string() }),
  z.object({ type: z.literal('error'), code: z.string() }),
  z.object({ type: z.literal('complete') }),
]);
export const ApplicationCatalogSchema = z.object({
  protocol: z.object({ min: z.number().int(), max: z.number().int() }),
  routes: z.array(
    z.object({
      operation: z.string(),
      path: z.string(),
      verb: z.string(),
      status: z.number().int(),
      args: z.array(
        z.object({
          index: z.number().int().nonnegative(),
          type: z.nativeEnum(RouteParamtypes),
          name: z.string().optional(),
          passthrough: z.boolean().optional(),
        }),
      ),
    }),
  ),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      inputSchema: z.object({ type: z.literal('object') }).passthrough(),
      operation: z.string(),
    }),
  ),
});
