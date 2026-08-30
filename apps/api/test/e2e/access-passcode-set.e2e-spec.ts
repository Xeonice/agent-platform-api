import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { useEnv } from './_env';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import { PasscodeService } from '../../src/platform/access-passcode/passcode.service';

/**
 * `PUT /api/system/access-passcode` (10 §6.6 / 11 §3.1) — the WRITE half of the access
 * passcode, and the last piece of that feature that had no code.
 *
 * ── Why each spec builds its own app ON ITS OWN DATABASE FILE ────────────────────
 * Every case here changes whether the platform's front door is locked, and that state
 * now lives in `system_settings`. ⚠️ `':memory:'` — what every other e2e uses — would
 * NOT isolate it: `PlatformModule` MEMOIZES the connection per `DATABASE_URL`, and the
 * e2e project runs one process (singleFork), so every app built with `':memory:'`
 * shares ONE database. Measured: enabling a passcode in the first case 401'd the rest
 * of this file, and would have leaked into every other spec in the suite. A unique
 * file per case is the only thing that makes these independent.
 */
let open: INestApplication[] = [];
let restore: (() => void)[] = [];
let dbDirs: string[] = [];

async function build(envPatch: Record<string, string | undefined>): Promise<INestApplication> {
  const dir = mkdtempSync(join(tmpdir(), 'passcode-e2e-'));
  dbDirs.push(dir);
  restore.push(
    useEnv({
      DATABASE_URL: join(dir, 'platform.db'),
      PASSCODE_COOKIE_SECRET: undefined,
      ...envPatch,
    }),
  );
  const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = ref.createNestApplication();
  configurePlatformApp(app);
  await app.init();
  // ONE port per app (suite-hygiene): supertest would otherwise rebind an ephemeral
  // port per request, and this file has several apps alive in one process.
  await app.listen(0);
  open.push(app);
  return app;
}

afterEach(async () => {
  for (const a of open) await a.close();
  // restore in reverse order so nested patches unwind to the original environment.
  for (const r of restore.reverse()) r();
  for (const d of dbDirs) rmSync(d, { recursive: true, force: true });
  open = [];
  restore = [];
  dbDirs = [];
});

/** The passcode-less platform every UI-driven case starts from. */
const noEnvPasscode = { ACCESS_PASSCODE: undefined };

describe('PUT /api/system/access-passcode — enable', () => {
  it('returns the 16-char plaintext ONCE and locks the door from that moment', async () => {
    const app = await build(noEnvPasscode);
    const http = () => request(app.getHttpServer());
    // before: no passcode, protected routes are open
    await http().get('/api/system/settings').expect(200);

    const res = await http()
      .put('/api/system/access-passcode')
      .send({ action: 'enable' })
      .expect(200);

    expect(res.body.enabled).toBe(true);
    expect(res.body.passcode).toHaveLength(16);
    expect(res.body.passcode).not.toMatch(/[0Ol1]/);

    // ⚠️ THE DOOR IS LOCKED WITHOUT A RESTART. `enabled` used to be a construction-time
    // snapshot of an env var; if it stayed one, this endpoint would report success and
    // change nothing until someone redeployed.
    await http().get('/api/system/settings').expect(401);
    // …and the new passcode is the one that opens it.
    await http().post('/api/access/unlock').send({ passcode: res.body.passcode }).expect(200);
  });

  it('never echoes the plaintext or the hash again, on any endpoint', async () => {
    const app = await build(noEnvPasscode);
    const http = () => request(app.getHttpServer());
    const created = await http()
      .put('/api/system/access-passcode')
      .send({ action: 'enable' })
      .expect(200);
    const plain = String(created.body.passcode);

    const unlock = await http().post('/api/access/unlock').send({ passcode: plain }).expect(200);
    const cookie = unlock.headers['set-cookie'];
    const settings = await http().get('/api/system/settings').set('Cookie', cookie).expect(200);

    // ⛔ 11 §3.1 / 10 §6.6: the response says WHETHER, never WHAT.
    expect(settings.body.accessPasscodeEnabled).toBe(true);
    expect(JSON.stringify(settings.body)).not.toContain(plain);
    expect(JSON.stringify(settings.body)).not.toContain('scrypt');
    expect(settings.body.accessPasscodeUpdatedAt).toBeTruthy();
  });

  it('refuses a second `enable` with 409 rather than silently rotating the passcode', async () => {
    const app = await build(noEnvPasscode);
    const http = () => request(app.getHttpServer());
    const first = await http()
      .put('/api/system/access-passcode')
      .send({ action: 'enable' })
      .expect(200);
    const plain = String(first.body.passcode);
    const cookie = (await http().post('/api/access/unlock').send({ passcode: plain }).expect(200))
      .headers['set-cookie'];

    const res = await http()
      .put('/api/system/access-passcode')
      .set('Cookie', cookie)
      .send({ action: 'enable' })
      .expect(409);

    expect(res.body).toMatchObject({
      code: 'INVALID_STATE',
      retryable: false,
      sideEffectFree: true,
    });
    // ⚠️ AND THE OLD PASSCODE STILL WORKS. That is what `sideEffectFree: true` claims;
    // a version that rotated first and threw afterwards would have made it a lie, and
    // the operator would be locked out holding a passcode nobody told them was stale.
    await http().post('/api/access/unlock').send({ passcode: plain }).expect(200);
  });
});

describe('PUT /api/system/access-passcode — regenerate', () => {
  it('issues a new passcode, kills the old one, and KEEPS existing sessions', async () => {
    const app = await build(noEnvPasscode);
    const http = () => request(app.getHttpServer());
    const first = String(
      (await http().put('/api/system/access-passcode').send({ action: 'enable' }).expect(200)).body
        .passcode,
    );
    const cookie = (await http().post('/api/access/unlock').send({ passcode: first }).expect(200))
      .headers['set-cookie'];

    const second = String(
      (
        await http()
          .put('/api/system/access-passcode')
          .set('Cookie', cookie)
          .send({ action: 'regenerate' })
          .expect(200)
      ).body.passcode,
    );

    expect(second).not.toBe(first);
    // ⚠️ THE LINE 11 §3.1 WRITES OUT IN FULL: 「已通过的会话不受口令重新生成影响」.
    // The cookie signing key used to fall back to the passcode itself, which would have
    // made every rotation a fleet-wide logout — invisible until the day someone rotated.
    await http().get('/api/system/settings').set('Cookie', cookie).expect(200);
    // the old passcode no longer opens the door; the new one does.
    await http().post('/api/access/unlock').send({ passcode: first }).expect(401);
    await http().post('/api/access/unlock').send({ passcode: second }).expect(200);
  });

  it('refuses `regenerate` when nothing is enabled — there is no passcode to rotate', async () => {
    const app = await build(noEnvPasscode);
    const res = await request(app.getHttpServer())
      .put('/api/system/access-passcode')
      .send({ action: 'regenerate' })
      .expect(409);
    expect(res.body).toMatchObject({ code: 'INVALID_STATE' });
    // still open — nothing was written.
    await request(app.getHttpServer()).get('/api/system/settings').expect(200);
  });
});

describe('PUT /api/system/access-passcode — disable', () => {
  it('opens the door again and is idempotent', async () => {
    const app = await build(noEnvPasscode);
    const http = () => request(app.getHttpServer());
    const plain = String(
      (await http().put('/api/system/access-passcode').send({ action: 'enable' }).expect(200)).body
        .passcode,
    );
    const cookie = (await http().post('/api/access/unlock').send({ passcode: plain }).expect(200))
      .headers['set-cookie'];

    const off = await http()
      .put('/api/system/access-passcode')
      .set('Cookie', cookie)
      .send({ action: 'disable' })
      .expect(200);
    expect(off.body).toEqual({ enabled: false });

    await http().get('/api/system/settings').expect(200);
    // idempotent: the target state is 「off」, and reaching it twice is not a conflict.
    await http().put('/api/system/access-passcode').send({ action: 'disable' }).expect(200);
  });

  it('records the disable as an `error`-level audit row — the one that must be findable', async () => {
    const app = await build(noEnvPasscode);
    const http = () => request(app.getHttpServer());
    const plain = String(
      (await http().put('/api/system/access-passcode').send({ action: 'enable' }).expect(200)).body
        .passcode,
    );
    // ⚠️ ENABLING LOCKS OUT THE CALLER WHO ENABLED IT — there was no session before,
    // because there was no door. The plaintext is already in hand from the response, so
    // the way back in is `POST /api/access/unlock`, exactly as a user would do it.
    const cookie = (await http().post('/api/access/unlock').send({ passcode: plain }).expect(200))
      .headers['set-cookie'];
    await http()
      .put('/api/system/access-passcode')
      .set('Cookie', cookie)
      .send({ action: 'disable' })
      .expect(200);

    const audit = await http().get('/api/system/audit?category=system').expect(200);
    const rows = audit.body.items as { type: string; severity: string; detail?: unknown }[];
    const changed = rows.filter((r) => r.type === 'system.access.passcode_changed');
    // ⚠️ WITHOUT THIS ROW, TURNING THE FRONT DOOR OFF LEAVES NO TRACE AT ALL:
    // `disable` clears `access_passcode_updated_at` to NULL, so the only other witness
    // erases itself in the same statement.
    expect(changed.map((r) => r.severity)).toEqual(['error', 'info']); // seq DESC
    expect(JSON.stringify(changed)).not.toContain('scrypt');
  });
});

describe('an ACCESS_PASSCODE pinned by the deployment', () => {
  it('is reported as enabled and refuses every write with 409', async () => {
    const app = await build({ ACCESS_PASSCODE: 'S1TestPasscode99' });
    const http = () => request(app.getHttpServer());
    const cookie = (
      await http().post('/api/access/unlock').send({ passcode: 'S1TestPasscode99' }).expect(200)
    ).headers['set-cookie'];

    for (const action of ['enable', 'regenerate', 'disable']) {
      const res = await http()
        .put('/api/system/access-passcode')
        .set('Cookie', cookie)
        .send({ action })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'INVALID_STATE', sideEffectFree: true });
      expect(res.body.message).toContain('ACCESS_PASSCODE');
    }

    // ⚠️ INCLUDING `disable`. Answering 200 there would be the worst outcome available:
    // the operator is told the door is open, and it is not — the platform cannot edit
    // the deployment file that holds the passcode.
    await http().post('/api/access/unlock').send({ passcode: 'S1TestPasscode99' }).expect(200);
    expect(app.get(PasscodeService).enabled).toBe(true);
  });
});

describe('the request body itself', () => {
  it('rejects an unknown action with a VALIDATION_FAILED envelope', async () => {
    const app = await build(noEnvPasscode);
    const res = await request(app.getHttpServer())
      .put('/api/system/access-passcode')
      .send({ action: 'rotate' })
      .expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', sideEffectFree: true });
    await request(app.getHttpServer()).get('/api/system/settings').expect(200);
  });
});
