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
  args: { index: number; type: number; name?: string; passthrough?: boolean }[];
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
