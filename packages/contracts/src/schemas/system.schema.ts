import { z } from 'zod';

/** GET /api/health — passcode-exempt liveness probe (shared/11 §3.1). */
export const HealthDtoSchema = z.object({
  status: z.literal('ok'),
  uptimeSec: z.number().nonnegative(),
});
export type HealthDto = z.infer<typeof HealthDtoSchema>;
