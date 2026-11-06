import 'reflect-metadata';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { resolve } from 'node:path';
import { Controller, Get, Req, Res, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_RECORDER } from '@platform/contracts';
import { CLOCK, DATABASE, ID_GENERATOR, fromEpochMs } from '@platform/shared-kernel';
import { configurePlatformApp } from '../../../apps/api/src/bootstrap/configure-app';
import { DeploymentState } from '../../../apps/api/src/platform/deployment/deployment-state';
import { PasscodeService } from '../../../apps/api/src/platform/access-passcode/passcode.service';
import { PasscodeGuard } from '../../../apps/api/src/platform/access-passcode/passcode.guard';
import { PasscodeAttemptLimiter } from '../../../apps/api/src/platform/access-passcode/passcode-attempt-limiter';
import { AccessController } from '../../../apps/api/src/platform/access-passcode/access.controller';
import { AccessPasscodeService } from '../../../apps/api/src/platform/access-passcode/access-passcode.service';
import { PasscodeTerminalAuthenticator } from '../../../apps/api/src/platform/access-passcode/passcode-terminal-authenticator';
import { UpgradeSecurity } from '../../../apps/api/src/platform/access-passcode/upgrade-security.service';
import { createAccessAuthorityClient } from '../../../apps/api/src/platform/access-passcode/access-authority-client';
import { hashPasscode } from '../../../apps/api/src/platform/access-passcode/passcode-hash';
import { SystemController } from '../../../apps/api/src/platform/system/system.controller';
import { SystemSettingsService } from '../../../apps/api/src/platform/system/system-settings.service';
import { InitializationService } from '../../../apps/api/src/platform/system/initialization.service';
import { PresetImageProvisioner } from '../../../apps/api/src/platform/system/preset-image/preset-image-provisioner';
import { SystemResourcesService } from '../../../apps/api/src/platform/system/system-resources.service';
import { SystemVersionService } from '../../../apps/api/src/platform/system/system-version.service';
import { SystemProvidersService } from '../../../apps/api/src/platform/system/system-providers.service';
import { DiagnosticsService } from '../../../apps/api/src/platform/system/diagnostics/diagnostics.service';
import { ProviderLogService } from '../../../apps/api/src/platform/audit/provider-log.service';
import { currentDatabase } from '../../support/sqlite';
import { useEnv } from '../../support/strict-ports';
type Request = Parameters<UpgradeSecurity['principal']>[0];
type Response = Parameters<UpgradeSecurity['principal']>[1];
interface Authority {
  importState(input: Record<string, unknown>): Promise<unknown>;
  issueSessionToken(now?: number): string;
  status(): { enabled: boolean; source: string; revision: number };
  verifySessionToken(token: string): boolean;
}
interface AuthorityModule {
  createControlAccessAuthority(input: Record<string, unknown>): Authority;
  createControlAccessHttpHandler(input: {
    authority: Authority;
    instanceId: string;
    key: string;
  }): (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}
const authorityModule: AuthorityModule = await import(
  resolve(process.cwd(), '../deploy/upgrade/control-access-authority.mjs')
);
const instance = 'authority-protocol-fixture',
  key = 'fixture-private-access-authority-key-32-bytes',
  plain = 'fixture-old-passcode',
  secret = 'fixture-original-cookie-signing-secret';
const origin = 'http://127.0.0.1:45291';
@Controller('authority-boundary')
class AuthorityBoundary {
  constructor(private readonly security: UpgradeSecurity) {}
  @Get('status') status(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.security.principal(req, res, instance);
  }
}
let app: INestApplication,
  server: Server,
  sqlite: Database.Database,
  authority: Authority,
  passcodes: PasscodeService,
  database: ReturnType<typeof currentDatabase>,
  restore: () => void;
let rpcOrigin: string,
  dropChangeResponse = false,
  stallAuthenticate = false,
  changeRequests = 0;
const audits: unknown[] = [];
beforeEach(async () => {
  dropChangeResponse = false;
  stallAuthenticate = false;
  changeRequests = 0;
  audits.length = 0;
  sqlite = new Database(':memory:');
  authority = authorityModule.createControlAccessAuthority({
    sqlite,
    instanceId: instance,
    envPasscode: '',
    sessionSecretOverride: '',
  });
  await authority.importState({
    source: 'stored',
    passcodeHash: hashPasscode(plain),
    sessionSecret: secret,
    upgradeSessionSecretBase64: Buffer.alloc(32, 7).toString('base64'),
    updatedAt: Date.now(),
  });
  const handler = authorityModule.createControlAccessHttpHandler({
    authority,
    instanceId: instance,
    key,
  });
  server = createServer((req, res) => {
    if (req.url?.endsWith('/change')) {
      changeRequests++;
      if (dropChangeResponse)
        res.end = (() => {
          res.destroy();
          return res;
        }) as typeof res.end;
    }
    if (stallAuthenticate && req.url?.endsWith('/authenticate')) {
      req.resume();
      return;
    }
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture listener missing');
  rpcOrigin = `http://127.0.0.1:${String(address.port)}`;
  restore = useEnv({
    UPGRADE_ACCESS_AUTHORITY_ORIGIN: rpcOrigin,
    UPGRADE_ACCESS_AUTHORITY_KEY: key,
    PLATFORM_INSTANCE_ID: instance,
    ACCESS_PASSCODE_ALLOW_LOOPBACK: 'false',
    ACCESS_PASSCODE_AUTO_GENERATE: 'false',
    API_ALLOWED_ORIGINS: origin,
    UPGRADE_SESSION_SECRET: undefined,
    PASSCODE_COOKIE_SECRET: undefined,
  });
  database = currentDatabase();
  // A business access-policy SELECT/UPDATE is forbidden in delegated mode.
  passcodes = new PasscodeService(
    new Proxy(database.db, {
      get() {
        throw new Error('business access policy touched');
      },
    }),
  );
  const providers = [
    InitializationService,
    PresetImageProvisioner,
    SystemResourcesService,
    SystemVersionService,
    SystemProvidersService,
    DiagnosticsService,
    ProviderLogService,
  ].map((provide) => ({ provide, useValue: {} }));
  const module = await Test.createTestingModule({
    controllers: [AuthorityBoundary, AccessController, SystemController],
    providers: [
      ...providers,
      UpgradeSecurity,
      DeploymentState,
      AccessPasscodeService,
      SystemSettingsService,
      { provide: PasscodeService, useValue: passcodes },
      { provide: PasscodeAttemptLimiter, useValue: new PasscodeAttemptLimiter() },
      { provide: DATABASE, useValue: database.db },
      { provide: AUDIT_RECORDER, useValue: { record: (value: unknown) => audits.push(value) } },
      { provide: CLOCK, useValue: { now: () => fromEpochMs(Date.now()) } },
      { provide: ID_GENERATOR, useValue: { next: () => randomUUID() } },
    ],
  }).compile();
  app = module.createNestApplication();
  app.useGlobalGuards(new PasscodeGuard(passcodes, module.get(PasscodeAttemptLimiter)));
  configurePlatformApp(app, { allowedOrigins: [origin], trustProxy: 'none' });
  await app.listen(0, '127.0.0.1');
});
afterEach(async () => {
  if (app) await app.close();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  sqlite?.close();
  database?.sqlite.close();
  restore?.();
});
function cookies(response: { headers: Record<string, unknown> }): string {
  return ((response.headers['set-cookie'] ?? []) as string[])
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function unlock() {
  return cookies(
    await request(app.getHttpServer())
      .post('/api/access/unlock')
      .send({ passcode: plain })
      .expect(200),
  );
}
function client() {
  return createAccessAuthorityClient({ origin: rpcOrigin, key, instanceId: instance });
}
function authRequest(cookie: string) {
  return { remoteAddress: '198.51.100.2', clientIp: '198.51.100.2', cookie };
}
describe('ACC/UPG independent authority — real SQLite/private HTTP/API boundary', () => {
  it('old signed cookie opens HTTP and WS, preserves viewer/CSRF, and never reads business access state', async () => {
    const expiry = String(Date.now() + 604800000),
      token = `${expiry}.${createHmac('sha256', secret).update(expiry).digest('hex')}`;
    const session = `ap_session=${token}`,
      first = await request(app.getHttpServer())
        .get('/api/authority-boundary/status')
        .set('Cookie', session)
        .expect(200);
    expect(first.body.canUpgrade).toBe(true);
    const combined = session + '; ' + cookies(first);
    const second = await request(app.getHttpServer())
      .get('/api/authority-boundary/status')
      .set('Cookie', combined)
      .expect(200);
    expect(second.body).toEqual(first.body);
    const terminal = new PasscodeTerminalAuthenticator(passcodes, {
      now: () => fromEpochMs(Date.now()),
    });
    expect(await terminal.authorize({ remoteAddress: '198.51.100.2', sessionToken: token })).toBe(
      true,
    );
    expect(await terminal.authorize({ remoteAddress: '198.51.100.2', passcode: 'wrong' })).toBe(
      false,
    );
    const settings = await request(app.getHttpServer())
      .get('/api/system/settings')
      .set('Cookie', session)
      .expect(200);
    expect(settings.body.accessPasscodeEnabled).toBe(true);
    expect(settings.body.accessPasscodeUpdatedAt).toBeTypeOf('string');
    const security = app.get(UpgradeSecurity),
      proof = await security.continuityEvidence(instance),
      challenge = await security.continuityChallengeAsync(instance);
    expect(proof.policyRevision).toBe(authority.status().revision);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/authority-boundary/status')
          .set('Cookie', challenge.cookie)
          .expect(200)
      ).body.userScope,
    ).toBe(challenge.userScope);
  });
  it('real settings preserve old sessions normally; explicit revoke rejects old HTTP/WS and issues the same change session', async () => {
    const session = await unlock();
    const regenerated = await request(app.getHttpServer())
      .put('/api/system/access-passcode')
      .set('Cookie', session)
      .send({ action: 'regenerate' })
      .expect(200);
    expect(regenerated.body.passcode).toHaveLength(16);
    await request(app.getHttpServer())
      .get('/api/system/settings')
      .set('Cookie', session)
      .expect(200);
    const revoked = await request(app.getHttpServer())
      .put('/api/system/access-passcode')
      .set('Cookie', session)
      .send({ action: 'regenerate', invalidateSessions: true })
      .expect(200);
    const replacement = cookies(revoked);
    expect(replacement).toContain('ap_session=');
    await request(app.getHttpServer())
      .get('/api/system/settings')
      .set('Cookie', session)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/system/settings')
      .set('Cookie', replacement)
      .expect(200);
    const terminal = new PasscodeTerminalAuthenticator(passcodes, {
      now: () => fromEpochMs(Date.now()),
    });
    expect(
      await terminal.authorize({
        remoteAddress: '198.51.100.2',
        sessionToken: session.split('=')[1],
      }),
    ).toBe(false);
    expect(
      (
        await request(app.getHttpServer())
          .put('/api/system/access-passcode')
          .set('Cookie', replacement)
          .send({ action: 'disable' })
          .expect(200)
      ).body.enabled,
    ).toBe(false);
    expect(
      (await request(app.getHttpServer()).get('/api/system/settings').expect(200)).body
        .accessPasscodeEnabled,
    ).toBe(false);
    expect(audits.length).toBe(4);
    expect(JSON.stringify(audits)).not.toContain(revoked.body.passcode);
    expect(
      database.sqlite
        .prepare('SELECT access_passcode_hash, access_passcode_session_secret FROM system_settings')
        .get(),
    ).toEqual({ access_passcode_hash: null, access_passcode_session_secret: null });
  });
  it('shared lock rejects sixth guess while valid original cookie remains usable', async () => {
    const session = await unlock();
    for (let i = 0; i < 5; i++)
      await request(app.getHttpServer())
        .post('/api/access/unlock')
        .send({ passcode: 'wrong' })
        .expect(401);
    await request(app.getHttpServer())
      .post('/api/access/unlock')
      .send({ passcode: plain })
      .expect(429);
    await request(app.getHttpServer())
      .get('/api/system/settings')
      .set('Cookie', session)
      .expect(200);
    expect(audits.length).toBe(8);
  });
  it('lost change response after commit stays unknown, never retries or silently gets a later session', async () => {
    const token = authority.issueSessionToken(),
      before = authority.status().revision;
    dropChangeResponse = true;
    await expect(
      client().change(authRequest(`ap_session=${token}`), {
        action: 'regenerate',
        invalidateSessions: true,
      }),
    ).rejects.toMatchObject({
      response: { code: 'ACCESS_AUTHORITY_UNAVAILABLE', sideEffectFree: false },
    });
    expect(changeRequests).toBe(1);
    expect(authority.status().revision).toBe(before + 1);
    expect(authority.verifySessionToken(token)).toBe(false);
    expect(() => passcodes.issueCurrentSessionToken()).toThrow();
    await expect(async () => passcodes.issueCurrentSessionTokenAsync()).rejects.toThrow();
  });
  it('slow authority closes HTTP and WS at fixed 2s without legacy fallback', async () => {
    stallAuthenticate = true;
    const started = performance.now();
    await request(app.getHttpServer())
      .get('/api/system/settings')
      .set('Cookie', `ap_session=${authority.issueSessionToken()}`)
      .expect(503);
    expect(performance.now() - started).toBeLessThan(2600);
    const terminal = new PasscodeTerminalAuthenticator(passcodes, {
      now: () => fromEpochMs(Date.now()),
    });
    await expect(
      terminal.authorize({
        remoteAddress: '198.51.100.2',
        sessionToken: authority.issueSessionToken(),
      }),
    ).rejects.toMatchObject({ response: { code: 'ACCESS_AUTHORITY_UNAVAILABLE' } });
  });
});
