import { z } from 'zod';

// Decode actual observations before retaining their absent/unknown handling.
export const DockerStateSchema = z
  .object({
    Status: z.string().optional(),
    Running: z.boolean().optional(),
    ExitCode: z.number().optional(),
    StartedAt: z.string().optional(),
    FinishedAt: z.string().optional(),
    Health: z
      .object({ Status: z.string().optional(), FailingStreak: z.number().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export const DockerInspectSchema = z
  .object({
    State: DockerStateSchema.optional(),
    Name: z.string().optional(),
    NetworkSettings: z
      .object({
        Networks: z.record(z.unknown()).optional(),
        Ports: z
          .record(
            z
              .array(
                z
                  .object({ HostIp: z.string().optional(), HostPort: z.string().optional() })
                  .passthrough(),
              )
              .nullable(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export const DockerContainersSchema = z.array(
  z
    .object({
      Id: z.string(),
      State: z.string(),
      Names: z.array(z.string()).optional(),
      Labels: z.record(z.string()).optional(),
    })
    .passthrough(),
);
