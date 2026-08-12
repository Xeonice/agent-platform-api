import { z } from 'zod';
import { SandboxStatusSchema, TimeoutMinutesSchema } from './enums';

/**
 * zod single source (docs/backend/02 §3). These schemas produce, from one place:
 *   - REST DTO (via createZodDto in the interface layer)
 *   - Swagger/OpenAPI reflection (nestjs-zod patchNestJsSwagger)
 *   - MCP tool inputSchema (@Tool parameters)
 * Wire types are camelCase (02 §5.1).
 */
export const CreateSandboxSchema = z.object({
  projectId: z.string().min(1),
  runtime: z.string().min(1),
  image: z.string().optional(),
  provider: z.string().optional(),
  initialPrompt: z.string().optional(),
  headless: z.boolean().optional(),
  timeoutMinutes: TimeoutMinutesSchema.optional(),
});
export type CreateSandboxInput = z.infer<typeof CreateSandboxSchema>;

export const ListSandboxesQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
});
export type ListSandboxesQuery = z.infer<typeof ListSandboxesQuerySchema>;

export const SandboxDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  runtime: z.string(),
  status: SandboxStatusSchema,
  headless: z.boolean(),
  timeoutMinutes: TimeoutMinutesSchema.nullable(),
  idleTimeoutSec: z.number().int().positive(),
  /** derived, projected from the terminal gateway; never persisted (28 §4). */
  waitingInput: z.boolean(),
  version: z.number().int().nonnegative(),
});
export type SandboxDto = z.infer<typeof SandboxDtoSchema>;
