import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { MasterKeyProvider } from '../../src/infrastructure/crypto/master-key.provider';

describe('MasterKeyProvider (05 §4.2)', () => {
  let dataRoot: string;
  const savedDataRoot = process.env.DATA_ROOT;
  const savedKey = process.env.PLATFORM_MASTER_KEY;

  beforeEach(() => {
    dataRoot = mkdtempSync(resolve(tmpdir(), 'mkey-'));
    process.env.DATA_ROOT = dataRoot;
    delete process.env.PLATFORM_MASTER_KEY;
  });
  afterEach(() => {
    if (savedDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = savedDataRoot;
    if (savedKey === undefined) delete process.env.PLATFORM_MASTER_KEY;
    else process.env.PLATFORM_MASTER_KEY = savedKey;
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('auto-generates a 32-byte key exclusively at 0600, stable across providers', () => {
    const m1 = new MasterKeyProvider().material();
    expect(m1.key.length).toBe(32);
    expect(m1.keyId).toMatch(/^[0-9a-f]{16}$/);

    const keyPath = resolve(dataRoot, '.master.key');
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    // a second provider reads the SAME file (EEXIST path), same key + fingerprint.
    const m2 = new MasterKeyProvider().material();
    expect(m2.key.equals(m1.key)).toBe(true);
    expect(m2.keyId).toBe(m1.keyId);
  });

  it('env PLATFORM_MASTER_KEY (base64) takes priority over the file', () => {
    const raw = randomBytes(32);
    process.env.PLATFORM_MASTER_KEY = raw.toString('base64');
    const m = new MasterKeyProvider().material();
    expect(m.key.equals(raw)).toBe(true);
    expect(m.keyId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('caches within a provider instance', () => {
    const p = new MasterKeyProvider();
    expect(p.material()).toBe(p.material());
  });
});
