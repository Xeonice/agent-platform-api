import type { SandboxDto, SandboxHealthWire } from '@platform/contracts';
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
  /**
   * `health` 与 `waitingInput` 一样是**派生字段**：它不在聚合上，由调用方从
   * `SandboxHealthMonitor` 的当前观测里取（03 §7.8）。
   *
   * ⚠️ **没有观测就整个字段缺席**，不退化成 `unknown` 或 `healthy` —— 缺席的语义是
   * 「平台这一刻没有观测」，而老客户端读不到它时行为与今天完全一致（`status` 仍是
   * `running`）。这正是可选字段相对枚举扩展的全部好处。
   */
  toDto(agg: Sandbox, waitingInput: boolean, health?: SandboxHealthWire): SandboxDto {
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
      ...(health === undefined ? {} : { health }),
    };
  },
};
