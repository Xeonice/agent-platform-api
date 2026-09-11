import { Inject, Injectable } from '@nestjs/common';
import { asSandboxId } from '@platform/shared-kernel';
import {
  SANDBOX_PROVIDER_REGISTRY,
  SANDBOX_WORKSPACE_MOUNT,
  SandboxProviderError,
  SandboxProviderErrorCode,
  toExecFn,
} from '@platform/contracts';
import type {
  ProviderRegistry,
  SandboxExecFn,
  SandboxExecPort,
  SandboxRuntimeBinding,
} from '@platform/contracts';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../domain/repositories/sandbox.repository';
import type { Sandbox } from '../domain/entities/sandbox.entity';

/**
 * Sandbox-side implementation of `SANDBOX_EXEC_PORT` (sibling of `SandboxPtyAdapter`).
 * It resolves the provider + persisted handle and derives the one-shot exec from
 * `spawn({tty:false})` via the platform's `toExecFn` (04 §2.3) — so the `terminal`
 * context can probe a live sandbox (does the agent tmux session still exist?) without
 * ever seeing the sandbox aggregate or a provider handle.
 */
@Injectable()
export class SandboxExecAdapter implements SandboxExecPort {
  constructor(
    @Inject(SANDBOX_REPOSITORY) private readonly repo: SandboxRepository,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
  ) {}

  async execFor(sandboxId: string): Promise<SandboxExecFn> {
    const sandbox = await this.requireRunning(sandboxId);
    const provider = this.registry.get(sandbox.provider);
    return toExecFn(provider, {
      provider: sandbox.provider,
      providerSandboxId: sandbox.providerSandboxId as string,
      providerState: sandbox.providerState ?? undefined,
    });
  }

  async bindingOf(sandboxId: string): Promise<SandboxRuntimeBinding> {
    const sandbox = await this.requireRunning(sandboxId);
    return {
      sandboxId,
      runtimeId: sandbox.runtime,
      // 终端要据它决定「+ 新终端」下拉能开哪几个 CLI（06 §5.6）。
      // ⛔ 读的是聚合上的记录（∪ 默认），不是"现在配了哪些凭证"——
      //    两者在 provision 之后就会分叉，只有记录与盒子里的事实对得上。
      availableRuntimes: sandbox.availableRuntimes,
      workdir: SANDBOX_WORKSPACE_MOUNT,
    };
  }

  private async requireRunning(sandboxId: string): Promise<Sandbox> {
    const sandbox = await this.repo.findById(asSandboxId(sandboxId));
    if (!sandbox || !sandbox.providerSandboxId) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        `sandbox ${sandboxId} has no running instance to exec into`,
      );
    }
    return sandbox;
  }
}
