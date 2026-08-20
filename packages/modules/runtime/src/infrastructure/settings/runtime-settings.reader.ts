import { Inject, Injectable } from '@nestjs/common';
import type { Tx } from '@platform/shared-kernel';
import type { RuntimeSettingsReader, RuntimeSettingsWriter } from '@platform/contracts';
import { RuntimeSettings } from '../../domain/entities/runtime-settings.entity';
import { RUNTIME_SETTINGS_REPOSITORY } from '../../domain/repositories/runtime-settings.repository';
import type { RuntimeSettingsRepository } from '../../domain/repositories/runtime-settings.repository';

/**
 * Implements the contracts `RUNTIME_SETTINGS_READER` + `RUNTIME_SETTINGS_WRITER` so
 * the credential context can read the effective mode (for `prepareRuntimeCredential`)
 * and write the first-config `runtime_settings` row INSIDE the credential store tx
 * (R-1 ②), all WITHOUT a credential→runtime package dependency — the coupling is via
 * these contracts tokens only.
 */
@Injectable()
export class RuntimeSettingsReaderWriter implements RuntimeSettingsReader, RuntimeSettingsWriter {
  constructor(
    @Inject(RUNTIME_SETTINGS_REPOSITORY) private readonly repo: RuntimeSettingsRepository,
  ) {}

  async activeAuthMethod(runtimeId: string): Promise<'account' | 'api-key' | null> {
    const s = await this.repo.findByRuntime(runtimeId);
    return s ? s.activeAuthMethod : null;
  }

  saveSync(tx: Tx, runtimeId: string, mode: 'account' | 'api-key', now: Date): void {
    this.repo.saveSync(tx, RuntimeSettings.create(runtimeId, mode, now));
  }
}
