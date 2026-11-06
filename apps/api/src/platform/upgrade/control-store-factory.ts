import type Database from 'better-sqlite3';
import type { Clock, IdGenerator } from '@platform/shared-kernel';
import { UpgradeStore } from './upgrade-store';
import { UpgradeOperationStore } from './upgrade-operation-store';
import { UpgradeContractStore } from './upgrade-contract-store';
import type { UpgradeStoreOptions } from './upgrade-control-bridge';
import { requireUpgrade } from './upgrade-trust';
import { UPGRADE_CONTROL_SCHEMA_SQL, UPGRADE_CONTROL_SCHEMA_VERSION } from './control-store-schema';

export { freezeUpgradeChain } from './upgrade-chain';
export {
  freezeUpgradePlan,
  verifyUpgradeEnvelope,
  readUpgradeTrustRoot,
  upgradeDigest,
  canonicalUpgrade,
} from './upgrade-trust';
export { UPGRADE_CONTROL_CAPABILITIES } from './upgrade-control-bridge';

/** Caller owns the SQLite lifetime, private file permissions and single-executor lock.
 * This factory does not start Nest, business services, SDKs or background timers. */
export function createUpgradeControlStores(input: {
  sqlite: Database.Database;
  instanceId: string;
  clock: Clock;
  ids: IdGenerator;
  claimGuard?: UpgradeStoreOptions['claimGuard'];
  dataFormatGuard?: UpgradeStoreOptions['dataFormatGuard'];
  initialize?: boolean;
}) {
  const { sqlite, instanceId, clock, ids } = input;
  requireUpgrade(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(instanceId), 'INVALID_INSTANCE_ID');
  const business = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('upgrade_instances','upgrade_attempts','upgrade_steps','upgrade_events','upgrade_recoveries','upgrade_continuity_baselines','platform_operations') AND substr(name,1,8)!='control_' AND substr(name,1,7)!='sqlite_' LIMIT 1",
    )
    .get();
  requireUpgrade(!business, 'CONTROL_DATABASE_MUST_BE_INDEPENDENT');
  if (input.initialize !== false) {
    sqlite
      .transaction(() => {
        sqlite.exec(
          'CREATE TABLE IF NOT EXISTS control_store_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL, schema_version INTEGER NOT NULL)',
        );
        const metadata = sqlite
          .prepare<unknown[], { instance_id: string; schema_version: number }>(
            'SELECT instance_id,schema_version FROM control_store_metadata WHERE singleton=1',
          )
          .get();
        if (!metadata) {
          const existing = sqlite
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='upgrade_instances'",
            )
            .get();
          requireUpgrade(!existing, 'CONTROL_SCHEMA_UNREGISTERED');
          sqlite.exec(UPGRADE_CONTROL_SCHEMA_SQL);
          sqlite
            .prepare('INSERT INTO control_store_metadata VALUES(1,?,?)')
            .run(instanceId, UPGRADE_CONTROL_SCHEMA_VERSION);
        } else
          requireUpgrade(
            metadata.instance_id === instanceId &&
              metadata.schema_version === UPGRADE_CONTROL_SCHEMA_VERSION,
            'CONTROL_SCHEMA_OR_INSTANCE_MISMATCH',
          );
      })
      .immediate();
  }
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
  const store = new UpgradeStore(sqlite, clock, ids, {
    instanceId,
    readonly: input.initialize === false,
    independent: true,
    claimGuard: input.claimGuard,
    dataFormatGuard: input.dataFormatGuard,
  });
  return {
    store,
    operations: new UpgradeOperationStore(store, clock, ids),
    contracts: new UpgradeContractStore(store, clock, ids),
    controlSchemaVersion: UPGRADE_CONTROL_SCHEMA_VERSION,
  };
}

export {
  observeControlMetadataSource,
  bindControlMetadataSource,
  CONTROL_METADATA_MIGRATION,
} from '../persistence/control-metadata-schema-bridge';
