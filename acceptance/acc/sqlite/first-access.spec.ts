import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { Logger } from '@nestjs/common';
import { PasscodeService } from '../../../apps/api/src/platform/access-passcode/passcode.service';
import { PasscodeTerminalAuthenticator } from '../../../apps/api/src/platform/access-passcode/passcode-terminal-authenticator';

function db() {
  const sqlite = new Database(':memory:');
  const database = drizzle(sqlite);
  migrate(database, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  return { sqlite, database };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('ACC 默认口令与会话轮换', () => {
  it('首次stdout给一次，数据库只有hash，重启不再显示明文', () => {
    vi.stubEnv('ACCESS_PASSCODE', '');
    vi.stubEnv('ACCESS_PASSCODE_AUTO_GENERATE', 'true');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logs = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const h = db();
    const service = new PasscodeService(h.database);
    const banner = String(output.mock.calls[0]?.[0]);
    const plain = banner.split('\n')[2];
    expect(plain).toHaveLength(16);
    expect(service.matches(plain)).toBe(true);
    const row = h.sqlite.prepare('SELECT * FROM system_settings').get();
    expect(JSON.stringify(row)).not.toContain(plain);
    expect(service.enabled).toBe(true);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(plain);
    const restarted = new PasscodeService(h.database);
    expect(output).toHaveBeenCalledTimes(1);
    expect(restarted.matches(plain)).toBe(true);
    h.sqlite.close();
  });
  it('可选轮换签名密钥失效旧会话，默认换口令保留会话', () => {
    vi.stubEnv('ACCESS_PASSCODE', '');
    vi.stubEnv('PASSCODE_COOKIE_SECRET', '');
    vi.stubEnv('ACCESS_PASSCODE_AUTO_GENERATE', 'false');
    const h = db();
    const service = new PasscodeService(h.database);
    service.setStoredPasscode('first', new Date(0));
    const old = service.issueSessionToken(1000);
    service.setStoredPasscode('second', new Date(1000));
    expect(service.verifySessionToken(old, 2000)).toBe(true);
    service.setStoredPasscode('third', new Date(2000), true);
    expect(service.verifySessionToken(old, 3000)).toBe(false);
    const next = service.issueSessionToken(3000);
    expect(new PasscodeService(h.database).verifySessionToken(next, 4000)).toBe(true);
    h.sqlite.close();
  });
  it('显式免回环仅允许socket回环地址', () => {
    vi.stubEnv('ACCESS_PASSCODE_AUTO_GENERATE', 'false');
    const h = db();
    const service = new PasscodeService(h.database);
    expect(service.allowsLoopback('127.0.0.1')).toBe(false);
    vi.stubEnv('ACCESS_PASSCODE_ALLOW_LOOPBACK', 'true');
    expect(service.allowsLoopback('127.0.0.1')).toBe(true);
    expect(service.allowsLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(service.allowsLoopback('::1')).toBe(true);
    expect(service.allowsLoopback('192.168.1.2')).toBe(false);
    h.sqlite.close();
  });
  it('WS同样只接受明确启用的真实回环peer，非回环仍需有效会话', () => {
    vi.stubEnv('ACCESS_PASSCODE_AUTO_GENERATE', 'false');
    vi.stubEnv('ACCESS_PASSCODE_ALLOW_LOOPBACK', 'false');
    const h = db();
    const service = new PasscodeService(h.database);
    service.setStoredPasscode('test-passcode', new Date(0));
    const auth = new PasscodeTerminalAuthenticator(service, { now: () => new Date(1000) });
    expect(auth.authorize({ remoteAddress: '127.0.0.1' })).toBe(false);
    vi.stubEnv('ACCESS_PASSCODE_ALLOW_LOOPBACK', 'true');
    expect(auth.authorize({ remoteAddress: '127.0.0.1' })).toBe(true);
    expect(auth.authorize({ remoteAddress: '192.168.1.2' })).toBe(false);
    expect(
      auth.authorize({
        remoteAddress: '192.168.1.2',
        sessionToken: service.issueSessionToken(1000),
      }),
    ).toBe(true);
    h.sqlite.close();
  });
});
