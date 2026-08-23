import type { SandboxDto } from '@platform/contracts';
import type { Sandbox } from '../../domain/entities/sandbox.entity';

/**
 * Mapper — the ONLY place domain ↔ wire DTO conversion happens (28 §4/§8).
 * `waitingInput` is a derived field projected from the terminal gateway; it is
 * passed in, never read off the aggregate (28 §4).
 *
 * ★ `initialTask.prompt` is NEVER mapped (裁决 D-14): REST and MCP share this DTO, so
 * echoing it would hand any upstream agent every historical task instruction through
 * one `list_sandboxes`. `name` (derived from it at create time) is the display half.
 */
export const SandboxMapper = {
  toDto(agg: Sandbox, waitingInput: boolean): SandboxDto {
    return {
      id: agg.id as string,
      projectId: agg.projectId as string,
      runtime: agg.runtime,
      // the registry key the frontend needs to look this sandbox's capabilities up
      // against `GET /api/providers` after a reload.
      provider: agg.provider,
      name: agg.name,
      status: agg.status,
      headless: agg.headless,
      timeoutMinutes: agg.timeoutMinutes as SandboxDto['timeoutMinutes'],
      idleTimeoutSec: agg.idleTimeoutSec,
      waitingInput,
      version: agg.version,
      // async provisioning has no response left to carry a failure (04 §4), so the
      // persisted code is what survives a page reload; `undefined` unless failed.
      failureCode: agg.failureCode ?? undefined,
      failureMessage: agg.failureReason ?? undefined,
    };
  },
};
