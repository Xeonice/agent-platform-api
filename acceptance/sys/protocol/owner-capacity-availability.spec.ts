import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DATABASE } from '@platform/shared-kernel';
import {
  SANDBOX_FACADE,
  SandboxProviderError,
  SandboxProviderErrorCode,
  SystemResourcesDtoSchema,
  type SandboxFacade,
} from '@platform/contracts';
import { configurePlatformApp } from '../../../apps/api/src/bootstrap/configure-app';
import { DeploymentState } from '../../../apps/api/src/platform/deployment/deployment-state';
import { SystemController } from '../../../apps/api/src/platform/system/system.controller';
import { SystemResourcesService } from '../../../apps/api/src/platform/system/system-resources.service';
import { InitializationService } from '../../../apps/api/src/platform/system/initialization.service';
import { PresetImageProvisioner } from '../../../apps/api/src/platform/system/preset-image/preset-image-provisioner';
import { SystemSettingsService } from '../../../apps/api/src/platform/system/system-settings.service';
import { SystemVersionService } from '../../../apps/api/src/platform/system/system-version.service';
import { SystemProvidersService } from '../../../apps/api/src/platform/system/system-providers.service';
import { DiagnosticsService } from '../../../apps/api/src/platform/system/diagnostics/diagnostics.service';
import { AccessPasscodeService } from '../../../apps/api/src/platform/access-passcode/access-passcode.service';
import { PasscodeService } from '../../../apps/api/src/platform/access-passcode/passcode.service';
import { ProviderLogService } from '../../../apps/api/src/platform/audit/provider-log.service';
import { MEMORY_SOURCES } from '../../../apps/api/src/platform/system/memory.probe';
import { currentDatabase } from '../../support/sqlite';

const apps: INestApplication[] = [];
const databases: ReturnType<typeof currentDatabase>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const db of databases.splice(0)) db.sqlite.close();
});
async function fixture(defaultCapacity: SandboxFacade['defaultCapacity']) {
  const database = currentDatabase();
  databases.push(database);
  const module = await Test.createTestingModule({
    controllers: [SystemController],
    providers: [
      DeploymentState,
      SystemResourcesService,
      { provide: DATABASE, useValue: database.db },
      {
        provide: MEMORY_SOURCES,
        useValue: {
          readProcMeminfo: async () => 'MemTotal: 8388608 kB\nMemAvailable: 6291456 kB\n',
          runVmStat: async () =>
            'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1000000.\nPages inactive: 1000000.\nPages speculative: 0.\n',
          totalBytes: () => 8 * 1024 ** 3,
        },
      },
      { provide: SANDBOX_FACADE, useValue: { defaultCapacity } },
      ...[
        InitializationService,
        PresetImageProvisioner,
        SystemSettingsService,
        SystemVersionService,
        SystemProvidersService,
        DiagnosticsService,
        AccessPasscodeService,
        PasscodeService,
        ProviderLogService,
      ].map((provide) => ({ provide, useValue: {} })),
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  configurePlatformApp(app);
  await app.init();
  apps.push(app);
  return app;
}
describe('actual resources HTTP response preserves unknown Guest capacity', () => {
  it('reports explicit unavailable without leaking raw Owner details or losing ordinary host diagnostics', async () => {
    const app = await fixture(async () => {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        'private-owner-id /private/sdk secret-sentinel',
        undefined,
        true,
      );
    });
    const response = await request(app.getHttpServer()).get('/api/system/resources').expect(200);
    const body = SystemResourcesDtoSchema.parse(response.body);
    expect(body.capacityAvailability).toEqual({
      state: 'unavailable',
      reason: 'OWNER_CAPACITY_UNAVAILABLE',
    });
    expect(body.capacity).toBeUndefined();
    expect(body.activeTasks).toBe(0);
    expect(body.cpu.cores).toBeGreaterThan(0);
    expect(body.ram.totalBytes).toBeGreaterThan(0);
    expect(body.disk).toBeDefined();
    expect(JSON.stringify(response.body)).not.toMatch(
      /private-owner-id|private\/sdk|secret-sentinel/,
    );
  });
  it('keeps the prior successful capacity contract and omits an unavailable marker when measurement succeeds', async () => {
    const capacity = {
      remainingTasks: 2,
      registeredTasks: 7,
      maxTasks: 3,
      basis: 'current Owner CPU/RAM and global disk ledger',
    };
    const app = await fixture(async () => capacity);
    const response = await request(app.getHttpServer()).get('/api/system/resources').expect(200);
    const body = SystemResourcesDtoSchema.parse(response.body);
    expect(body.capacity).toEqual(capacity);
    expect(body.capacityAvailability).toBeUndefined();
  });
});
