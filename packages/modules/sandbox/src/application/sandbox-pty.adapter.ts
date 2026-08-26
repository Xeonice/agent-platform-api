import { Inject, Injectable } from '@nestjs/common';
import { asSandboxId } from '@platform/shared-kernel';
import {
  SANDBOX_PROVIDER_REGISTRY,
  SandboxProviderError,
  SandboxProviderErrorCode,
} from '@platform/contracts';
import type {
  ProcessStream,
  ProviderRegistry,
  SandboxPtyPort,
  OpenPtyOptions,
} from '@platform/contracts';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../domain/repositories/sandbox.repository';

/**
 * Sandbox-side implementation of the cross-context SandboxPtyPort (06 §3). It
 * resolves the sandbox's provider + handle and calls `provider.spawn({tty:true})`
 * — the terminal context never touches sandbox internals, only this port.
 */
@Injectable()
export class SandboxPtyAdapter implements SandboxPtyPort {
  constructor(
    @Inject(SANDBOX_REPOSITORY) private readonly repo: SandboxRepository,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly registry: ProviderRegistry,
  ) {}

  async openPty(sandboxId: string, opts: OpenPtyOptions): Promise<ProcessStream> {
    const sandbox = await this.repo.findById(asSandboxId(sandboxId));
    if (!sandbox || !sandbox.providerSandboxId) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        `sandbox ${sandboxId} has no running instance to attach a terminal to`,
      );
    }
    const provider = this.registry.get(sandbox.provider);
    return provider.spawn(
      {
        provider: sandbox.provider,
        providerSandboxId: sandbox.providerSandboxId,
        // rebuild the provider's private runtime binding from the DB so the terminal
        // reconnects even after a backend restart (empty in-memory state).
        // ⚠️ 平台一个键都不认（04 §2.2）：`aio` 往里放的是 agent bearer token，
        // `boxlite` 换成 native 数据面后放的是**空**（只凭 box id 就能接回微 VM）。
        // 这里若开始解释它的内容，那个「实现私有」的边界就白划了。
        providerState: sandbox.providerState ?? undefined,
      },
      {
        // Since S5 the caller ALWAYS supplies the command (the terminal context
        // attaches the platform's tmux agent session, 26 §8); a bare shell is only
        // the fallback for a caller that asks for nothing.
        cmd: opts.cmd ?? ['/bin/sh'],
        tty: true,
        cols: opts.cols,
        rows: opts.rows,
        reuse: opts.reuse,
      },
    );
  }
}
