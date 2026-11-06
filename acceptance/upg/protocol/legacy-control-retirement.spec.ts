import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createConnection,
  runMigrations,
} from '../../../apps/api/src/platform/persistence/drizzle.connection';
import {
  UpgradeInternalController,
  UpgradeContractInternalController,
} from '../../../apps/api/src/platform/upgrade/upgrade.controller';
import { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import { useEnv } from '../../support/strict-ports';
import { UpgradeService } from '../../../apps/api/src/platform/upgrade/upgrade-service';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { UpgradeContractService } from '../../../apps/api/src/platform/upgrade/upgrade-contract-service';
import { CoordinatorHandoff } from '../../../apps/api/src/platform/upgrade/coordinator-handoff';
import { UpgradeRoleHandoffs } from '../../../apps/api/src/platform/upgrade/upgrade-role-handoffs';
import { UpgradeObserver } from '../../../apps/api/src/platform/upgrade/upgrade-observer';
import { UpgradeOnlineMigration } from '../../../apps/api/src/platform/upgrade/upgrade-online-migration';
import { CoordinatorRecovery } from '../../../apps/api/src/platform/upgrade/coordinator-recovery';

const key = 'local-legacy-control-retirement-internal-key-32';
const internal = {
  'x-platform-internal-key': key,
  'x-platform-instance-id': 'legacy-control-retirement',
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Real Nest route dispatch and SQLite stores; never grants production adoption.
 * All disallowed routes fail before invoking any historical service operation. */
async function fixture(readonly: boolean) {
  const restore = useEnv({ PLATFORM_CONTROLLER_RPC_KEY: key });
  const directory = mkdtempSync(join(tmpdir(), 'legacy-control-retirement-'));
  const connection = createConnection(join(directory, 'platform.sqlite'));
  runMigrations(connection.db, connection.sqlite);
  const store = new UpgradeStore(
    connection.sqlite,
    { now: () => new Date() },
    { next: randomUUID },
    { instanceId: 'legacy-control-retirement', readonly },
  );
  let authenticated = 0;
  let observed = 0;
  const upgrades = {
    store,
    security: {
      internal: (req: Parameters<UpgradeSecurity['internal']>[0], id: string) => {
        UpgradeSecurity.prototype.internal(req, id);
        authenticated++;
      },
    },
    inspector: {
      processObserve: async () => {
        observed++;
        return { participants: [] };
      },
    },
  };
  const module = await Test.createTestingModule({
    controllers: [UpgradeInternalController, UpgradeContractInternalController],
    providers: [
      { provide: UpgradeService, useValue: upgrades },
      { provide: UpgradeContractService, useValue: {} },
      { provide: CoordinatorHandoff, useValue: {} },
      { provide: UpgradeRoleHandoffs, useValue: {} },
      { provide: UpgradeObserver, useValue: {} },
      { provide: UpgradeOnlineMigration, useValue: {} },
      { provide: CoordinatorRecovery, useValue: {} },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  await app.init();
  cleanup.push(async () => {
    await app.close();
    connection.sqlite.close();
    restore();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    http: app.getHttpServer(),
    authenticated: () => authenticated,
    observed: () => observed,
  };
}

const retired: ['get' | 'post', string][] = [
  ['get', '/internal/upgrades/pending'],
  ['post', '/internal/upgrades/bootstrap'],
  ['get', '/internal/upgrades/original-attempt'],
  ['post', '/internal/upgrades/original-attempt/claim'],
  ['post', '/internal/upgrades/original-attempt/authority-check'],
  ['post', '/internal/upgrades/original-attempt/lease-renew'],
  ['get', '/internal/upgrades/original-attempt/progress-checkpoint'],
  ['post', '/internal/upgrades/original-attempt/commit-receipt'],
  ['post', '/internal/upgrades/original-attempt/renew'],
  ['post', '/internal/upgrades/original-attempt/commit'],
  ['get', '/internal/upgrades/original-attempt/steps/original-step'],
  ['post', '/internal/upgrades/original-attempt/controller-handoff'],
  ['get', '/internal/contracts/original-contract'],
  ['post', '/internal/contracts/original-contract/check'],
];

describe('independent ledger retires only the historical control protocol', () => {
  it('denies every historical control route, including old installer activation/status and check-only renew', async () => {
    const f = await fixture(true);
    for (const [method, path] of retired) {
      const response = await request(f.http)
        [method](path)
        .set(internal)
        .send({ action: 'status', fence: 99, controllerId: null, checkOnly: true });
      expect(response.status, path).toBe(409);
      expect(response.body.code, path).toBe('LEGACY_CONTROL_PROTOCOL_RETIRED');
    }
    expect(f.authenticated()).toBe(retired.length);
  });

  it('authenticates before exposing retirement status', async () => {
    const f = await fixture(true);
    const response = await request(f.http).get('/internal/upgrades/pending');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('UPGRADE_INTERNAL_AUTH');
    expect(f.authenticated()).toBe(0);
  });

  it('keeps participant process inspection available through its authenticated route', async () => {
    const f = await fixture(true);
    const response = await request(f.http)
      .post('/internal/upgrades/process-observe')
      .set(internal)
      .send({});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ participants: [] });
    expect(f.authenticated()).toBe(1);
    expect(f.observed()).toBe(1);
  });

  it('leaves an original writable legacy instance pending query usable for its original recovery', async () => {
    const f = await fixture(false);
    const response = await request(f.http).get('/internal/upgrades/pending').set(internal);
    expect(response.status).toBe(200);
    expect(f.authenticated()).toBe(1);
  });
});
