import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { platformInstanceId } from '@platform/shared-kernel';
import { requireUpgrade } from './upgrade-trust';
import type { UpgradeStoreOptions } from './upgrade-control-bridge';
import { UPGRADE_CONTROL_SCHEMA_VERSION } from './control-store-schema';

/** Business roles may inspect a control ledger, but cannot migrate or write it. */
@Injectable()
export class UpgradeLedgerConnection implements OnModuleDestroy {
  private connection?: Database.Database;
  options(): UpgradeStoreOptions {
    const path = process.env.UPGRADE_CONTROL_DATABASE_PATH;
    if (!path) return {};
    requireUpgrade(isAbsolute(path) && resolve(path) === path, 'CONTROL_LEDGER_PATH_INVALID');
    const stat = lstatSync(path);
    requireUpgrade(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        (stat.mode & 0o077) === 0 &&
        realpathSync(path) === path &&
        (!process.getuid || stat.uid === process.getuid() || stat.uid === 0),
      'CONTROL_LEDGER_INSECURE',
    );
    const instanceId = platformInstanceId();
    const sqlite = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const metadata = sqlite
        .prepare<unknown[], { instance_id: string; schema_version: number }>(
          'SELECT instance_id,schema_version FROM control_store_metadata WHERE singleton=1',
        )
        .get();
      requireUpgrade(
        metadata?.instance_id === instanceId &&
          metadata.schema_version === UPGRADE_CONTROL_SCHEMA_VERSION,
        'CONTROL_SCHEMA_OR_INSTANCE_MISMATCH',
      );
    } catch (error) {
      sqlite.close();
      throw error;
    }
    this.connection = sqlite;
    return { instanceId, ledgerSqlite: sqlite, readonly: true };
  }
  onModuleDestroy(): void {
    this.connection?.close();
  }
}
