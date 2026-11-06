import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Post, Req, Res, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configurePlatformApp } from '../../../apps/api/src/bootstrap/configure-app';
import { DeploymentState } from '../../../apps/api/src/platform/deployment/deployment-state';
import { UpgradeController } from '../../../apps/api/src/platform/upgrade/upgrade.controller';
import { UpgradeContractStore } from '../../../apps/api/src/platform/upgrade/upgrade-contract-store';
import { UpgradeContractService } from '../../../apps/api/src/platform/upgrade/upgrade-contract-service';
import { UpgradeService } from '../../../apps/api/src/platform/upgrade/upgrade-service';
import { UpgradeStore } from '../../../apps/api/src/platform/upgrade/upgrade-store';
import { UpgradeOnlineMigration } from '../../../apps/api/src/platform/upgrade/upgrade-online-migration';
import { UpgradeContractBusiness } from '../../../apps/api/src/platform/upgrade/upgrade-contract-business';
import { PasscodeService } from '../../../apps/api/src/platform/access-passcode/passcode.service';
import { PasscodeGuard } from '../../../apps/api/src/platform/access-passcode/passcode.guard';
import { PasscodeAttemptLimiter } from '../../../apps/api/src/platform/access-passcode/passcode-attempt-limiter';
import { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import { currentDatabase } from '../../support/sqlite';
import { useEnv } from '../../support/strict-ports';

type Request = Parameters<UpgradeSecurity['principal']>[0];
type Response = Parameters<UpgradeSecurity['principal']>[1];
const origin = 'http://127.0.0.1:49210';
const operatorKey = 'synthetic-contract-operator-capability-32';
const instance = 'contract-http-authorization';
@Controller('fixture-access')
class AccessFixture {
  constructor(private readonly security: UpgradeSecurity) {}
  @Get() viewer(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.security.principal(req, res, instance);
  }
  @Post() grant(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { upgradeKey: string },
  ) {
    return this.security.grant(req, res, instance, body.upgradeKey);
  }
}
let app: INestApplication;
let db: ReturnType<typeof currentDatabase>;
let restore: () => void;
let passcodes: PasscodeService;
beforeEach(async () => {
  restore = useEnv({
    PLATFORM_INSTANCE_ID: instance,
    UPGRADE_SESSION_SECRET: 'synthetic-stable-contract-session-secret-32',
    UPGRADE_ADMIN_KEY: operatorKey,
    API_ALLOWED_ORIGINS: origin,
    ACCESS_PASSCODE: 'ordinary-shared-passcode',
    ACCESS_PASSCODE_ALLOW_LOOPBACK: 'false',
  });
  db = currentDatabase();
  const clock = { now: () => new Date() },
    ids = { next: () => randomUUID() };
  passcodes = new PasscodeService(db.db);
  const security = new UpgradeSecurity(clock, ids, passcodes);
  const upgrades = new UpgradeStore(db.sqlite, clock, ids);
  const contracts = new UpgradeContractStore(upgrades, clock, ids);
  // This protocol gate stops before runtime/installer inspection: no confirmed
  // installed release exists. Unreachable boundaries are absent, not faked
  // positive health/VM/retirement evidence. Native tests prove the positive chain.
  const contractService = new UpgradeContractService(
    contracts,
    new UpgradeContractBusiness(
      contracts,
      new UpgradeOnlineMigration(upgrades, clock),
      undefined as never,
      clock,
    ),
    undefined as never,
    security,
    clock,
  );
  const service = new UpgradeService(
    upgrades,
    undefined as never,
    security,
    undefined as never,
    clock,
    contractService,
  );
  const module = await Test.createTestingModule({
    controllers: [UpgradeController, AccessFixture],
    providers: [
      DeploymentState,
      { provide: UpgradeService, useValue: service },
      { provide: UpgradeSecurity, useValue: security },
    ],
  }).compile();
  app = module.createNestApplication();
  app.useGlobalGuards(new PasscodeGuard(passcodes, new PasscodeAttemptLimiter()));
  configurePlatformApp(app, { allowedOrigins: [origin], trustProxy: 'none' });
  await app.listen(0, '127.0.0.1');
});
afterEach(async () => {
  await app.close();
  db.sqlite.close();
  restore();
});
function cookies(response: { headers: Record<string, unknown> }) {
  return ((response.headers['set-cookie'] ?? []) as string[])
    .map((v) => v.split(';')[0])
    .join('; ');
}
async function viewer() {
  const session = 'ap_session=' + passcodes.issueCurrentSessionToken();
  const r = await request(app.getHttpServer())
    .get('/api/fixture-access')
    .set('Cookie', session)
    .expect(200);
  return { cookie: session + '; ' + cookies(r), csrf: r.body.csrfToken };
}
async function grant(v: Awaited<ReturnType<typeof viewer>>) {
  const r = await request(app.getHttpServer())
    .post('/api/fixture-access')
    .set('Origin', origin)
    .set('Cookie', v.cookie)
    .set('X-Upgrade-CSRF', v.csrf)
    .send({ upgradeKey: operatorKey })
    .expect(201);
  return v.cookie + '; ' + cookies(r);
}
const command = () => ({
  requestId: randomUUID(),
  targetPlanDigest: 'sha256:' + '1'.repeat(64),
  expectedActivationGeneration: 0,
  acknowledgeRollbackClosure: true,
});
function noIntent() {
  expect(
    db.sqlite
      .prepare("SELECT count(*) n FROM platform_operations WHERE role='project-name-contract'")
      .get(),
  ).toEqual({ n: 0 });
  expect(db.sqlite.prepare('SELECT count(*) n FROM upgrade_attempts').get()).toEqual({ n: 0 });
  expect(db.sqlite.prepare('SELECT count(*) n FROM upgrade_online_migrations').get()).toEqual({
    n: 0,
  });
}
describe('REQ-UPG-006/007 — actual contract controller, service and SQLite admission boundary', () => {
  it('a forged access cookie cannot authorize an irreversible contract', async () => {
    const v = await viewer();
    const denied = await request(app.getHttpServer())
      .post('/api/system/upgrade/contracts/requests')
      .set('Origin', origin)
      .set('Cookie', 'ap_session=ordinary-shared-passcode')
      .set('X-Upgrade-CSRF', v.csrf)
      .send(command())
      .expect(401);
    expect(denied.body.code).toBe('PASSCODE_REQUIRED');
    noIntent();
  });
  it('requires exact Origin and the automatic viewer CSRF before any contract or migration record', async () => {
    const v = await viewer(),
      other = await viewer(),
      cookie = await grant(v);
    for (const [source, csrf] of [
      [undefined, v.csrf],
      ['https://other.invalid', v.csrf],
      [origin, other.csrf],
    ]) {
      let r = request(app.getHttpServer())
        .post('/api/system/upgrade/contracts/requests')
        .set('Cookie', cookie)
        .set('X-Upgrade-CSRF', csrf);
      if (source) r = r.set('Origin', source);
      await r.send(command()).expect(403);
      noIntent();
    }
  });
  it('does not treat instance access or acknowledgement as installed-plan/retirement qualification', async () => {
    const v = await viewer(),
      cookie = await grant(v);
    const denied = await request(app.getHttpServer())
      .post('/api/system/upgrade/contracts/requests')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .set('X-Upgrade-CSRF', v.csrf)
      .send(command())
      .expect(409);
    expect(denied.body.code).toBe('CONTRACT_INSTALLED_RELEASE_UNCONFIRMED');
    noIntent();
    const unknown = await request(app.getHttpServer())
      .get('/api/system/upgrade/contracts/requests/' + randomUUID())
      .set('Cookie', cookie)
      .expect(404);
    expect(unknown.body.code).toBe('CONTRACT_REQUEST_NOT_FOUND');
    noIntent();
  });
  it('rejects an absent explicit acknowledgement or executable payload on the real public DTO', async () => {
    const v = await viewer(),
      cookie = await grant(v);
    for (const body of [
      { ...command(), acknowledgeRollbackClosure: false },
      { ...command(), argv: ['stop', 'vm'] },
    ]) {
      await request(app.getHttpServer())
        .post('/api/system/upgrade/contracts/requests')
        .set('Origin', origin)
        .set('Cookie', cookie)
        .set('X-Upgrade-CSRF', v.csrf)
        .send(body)
        .expect(400);
      noIntent();
    }
  });
});
