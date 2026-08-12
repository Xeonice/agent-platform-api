import type { SandboxDto } from '@platform/contracts';
import type { Sandbox } from '../../domain/entities/sandbox.entity';

/**
 * Mapper — the ONLY place domain ↔ wire DTO conversion happens (28 §4/§8).
 * `waitingInput` is a derived field projected from the terminal gateway; it is
 * passed in, never read off the aggregate (28 §4).
 */
export const SandboxMapper = {
  toDto(agg: Sandbox, waitingInput: boolean): SandboxDto {
    return {
      id: agg.id as string,
      projectId: agg.projectId as string,
      runtime: agg.runtime,
      status: agg.status,
      headless: agg.headless,
      timeoutMinutes: agg.timeoutMinutes as SandboxDto['timeoutMinutes'],
      idleTimeoutSec: agg.idleTimeoutSec,
      waitingInput,
      version: agg.version,
    };
  },
};
