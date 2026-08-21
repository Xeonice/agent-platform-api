import type { Tx } from '@platform/shared-kernel';
import type { RuntimeSettings } from '../entities/runtime-settings.entity';

/**
 * RuntimeSettingsRepository PORT (docs/backend/23 §7.6). Read async; write sync
 * (P0-2) so the first-config `runtime_settings` write can join the credential store
 * transaction (R-1 bounded exception ②).
 */
export interface RuntimeSettingsRepository {
  findByRuntime(runtimeId: string): Promise<RuntimeSettings | null>;
  saveSync(tx: Tx, settings: RuntimeSettings): void;
}

export const RUNTIME_SETTINGS_REPOSITORY = Symbol('RuntimeSettingsRepository');
