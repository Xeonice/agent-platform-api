import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createPlatform } from '../../support/platform-app';
import { PasscodeService } from '../../../apps/api/src/platform/access-passcode/passcode.service';

async function storedPlatform(extra: Record<string, string | undefined> = {}) {
  const h = await createPlatform({
    PASSCODE_COOKIE_SECRET: undefined,
    PASSCODE_COOKIE_SECURE: 'true',
    ...extra,
  });
  h.app.get(PasscodeService).setStoredPasscode('synthetic-first-passcode', new Date());
  return h;
}
function cookie(response: { headers: Record<string, unknown> }): string {
  const headers = response.headers['set-cookie'];
  expect(Array.isArray(headers)).toBe(true);
  return String((headers as string[])[0]).split(';')[0]!;
}
const unlock = (server: Parameters<typeof request>[0], passcode: string) =>
  request(server).post('/api/access/unlock').send({ passcode });

describe('ACC 真HTTP会话与轮换', () => {
  it('AC-ACC-002.2/006.1/007.1/007.2：默认轮换保留A/B，失效轮换仅给A新cookie且旧口令失效', async () => {
    const h = await storedPlatform();
    try {
      const server = h.app.getHttpServer();
      const a = await unlock(server, 'synthetic-first-passcode').expect(200);
      const b = await unlock(server, 'synthetic-first-passcode').expect(200);
      expect(a.headers['set-cookie'][0]).toMatch(
        /ap_session=.*HttpOnly; SameSite=Lax; Path=\/; Max-Age=604800; Secure/,
      );
      const first = await request(server)
        .put('/api/system/access-passcode')
        .set('Cookie', cookie(a))
        .send({ action: 'regenerate' })
        .expect(200);
      expect(first.body.passcode).toHaveLength(16);
      await request(server).get('/api/projects').set('Cookie', cookie(a)).expect(200);
      await request(server).get('/api/projects').set('Cookie', cookie(b)).expect(200);
      await unlock(server, 'synthetic-first-passcode').expect(401);
      await unlock(server, first.body.passcode).expect(200);
      const next = await request(server)
        .put('/api/system/access-passcode')
        .set('Cookie', cookie(a))
        .send({ action: 'regenerate', invalidateSessions: true })
        .expect(200);
      await request(server).get('/api/projects').set('Cookie', cookie(next)).expect(200);
      await request(server).get('/api/projects').set('Cookie', cookie(b)).expect(401);
      await unlock(server, first.body.passcode).expect(401);
      await unlock(server, next.body.passcode).expect(200);
      const settings = await request(server)
        .get('/api/system/settings')
        .set('Cookie', cookie(next))
        .expect(200);
      const audit = await request(server)
        .get('/api/system/audit')
        .set('Cookie', cookie(next))
        .expect(200);
      expect(JSON.stringify(settings.body)).not.toContain(next.body.passcode);
      expect(JSON.stringify(audit.body)).not.toContain(next.body.passcode);
      expect(JSON.stringify(audit.body)).toContain('invalidateSessions');
    } finally {
      await h.close();
    }
  });

  it('AC-ACC-007.3：签名密钥固定时409零副作用，旧口令与会话仍可用', async () => {
    const h = await storedPlatform({ PASSCODE_COOKIE_SECRET: 'synthetic-pinned-signing-secret' });
    try {
      const server = h.app.getHttpServer();
      const a = await unlock(server, 'synthetic-first-passcode').expect(200);
      const fail = await request(server)
        .put('/api/system/access-passcode')
        .set('Cookie', cookie(a))
        .send({ action: 'regenerate', invalidateSessions: true })
        .expect(409);
      expect(fail.body).toMatchObject({ sideEffectFree: true, code: 'INVALID_STATE' });
      expect(fail.body.message).toContain('PASSCODE_COOKIE_SECRET');
      await unlock(server, 'synthetic-first-passcode').expect(200);
      await request(server).get('/api/projects').set('Cookie', cookie(a)).expect(200);
    } finally {
      await h.close();
    }
  });

  it('AC-ACC-002.1/006.2/006.4：部署口令固定拒绝修改，过期cookie被门拦住，health仍豁免', async () => {
    const h = await createPlatform({
      ACCESS_PASSCODE: 'synthetic-fixed-passcode',
      PASSCODE_COOKIE_SECRET: undefined,
    });
    try {
      const server = h.app.getHttpServer();
      const a = await unlock(server, 'synthetic-fixed-passcode').expect(200);
      const fail = await request(server)
        .put('/api/system/access-passcode')
        .set('Cookie', cookie(a))
        .send({ action: 'regenerate' })
        .expect(409);
      expect(fail.body.sideEffectFree).toBe(true);
      expect(fail.body.message).toContain('ACCESS_PASSCODE');
      await unlock(server, 'synthetic-fixed-passcode').expect(200);
      const expired = h.app.get(PasscodeService).issueSessionToken(Date.now() - 8 * 86400_000);
      await request(server).get('/api/projects').set('Cookie', `ap_session=${expired}`).expect(401);
      await request(server).get('/api/health').expect(200);
    } finally {
      await h.close();
    }
  });
});
