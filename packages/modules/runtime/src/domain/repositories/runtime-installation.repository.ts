import type { Tx } from '@platform/shared-kernel';
import type { RuntimeInstallation } from '../entities/runtime-installation.entity';

/**
 * RuntimeInstallationRepository PORT (docs/backend/23 §7.6). Reads async, writes
 * sync-in-transaction (P0-2). Each write runs in its OWN short transaction started by
 * the install orchestrator — never in the sandbox create transaction T1 (13 §2.3.2).
 */
export interface RuntimeInstallationRepository {
  find(sandboxId: string, runtimeId: string): Promise<RuntimeInstallation | null>;
  listBySandbox(sandboxId: string): Promise<RuntimeInstallation[]>;
  saveSync(tx: Tx, installation: RuntimeInstallation): void;
}

export const RUNTIME_INSTALLATION_REPOSITORY = Symbol('RuntimeInstallationRepository');
