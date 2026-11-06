import { z } from 'zod';

export const BoxliteInfoSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    state: z.object({ status: z.string(), running: z.boolean() }).passthrough(),
    healthStatus: z
      .object({
        state: z.string().optional(),
        failures: z.number().optional(),
        lastCheck: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export const BoxliteInfosSchema = z.array(BoxliteInfoSchema.extend({ id: z.string() }));
