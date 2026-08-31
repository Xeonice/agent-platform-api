import { Inject, Injectable } from '@nestjs/common';
import type { CredentialStatus, RuntimeCredentialStateReader } from '@platform/contracts';
import { RuntimeCredentialService } from '@platform/credential';
import { RUNTIME_SETTINGS_REPOSITORY } from '../domain/repositories/runtime-settings.repository';
import type { RuntimeSettingsRepository } from '../domain/repositories/runtime-settings.repository';

/**
 * `RUNTIME_CREDENTIAL_STATE_READER` 的实现（contracts 口，automation 上下文消费）。
 *
 * 它是 `GET /api/runtimes` 那条读模型的**最小切面**：只取 `credentialStatus`，
 * 不组 DTO、不列 per-mode 卡片、更不物化任何凭证。调度器每分钟对每条到期规则问一次
 * 「能不能起」（03 §8.2 行 2），用完整 DTO 去回答一个是非题是白花的钱。
 *
 * ⚠️ **runtime 未注册 / 没有 `runtime_settings` 行 / 选不出生效凭证 ⇒ `'none'`。**
 * 三者对自动化的后果相同（跳过，`AUTH_EXPIRED`），而抛异常会让整轮扫描因为某条规则
 * 引用了一个已经卸载的 runtime 而停摆。
 */
@Injectable()
export class DefaultRuntimeCredentialStateReader implements RuntimeCredentialStateReader {
  constructor(
    @Inject(RUNTIME_SETTINGS_REPOSITORY) private readonly settings: RuntimeSettingsRepository,
    private readonly credentials: RuntimeCredentialService,
  ) {}

  async stateOf(runtimeId: string): Promise<CredentialStatus> {
    const row = await this.settings.findByRuntime(runtimeId);
    const view = await this.credentials.view(runtimeId, row?.activeAuthMethod ?? null);
    return view.credentialStatus;
  }
}
