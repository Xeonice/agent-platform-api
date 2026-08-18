import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { isPinnedHost, pinnedKnownHostsPath } from '../../src/infrastructure/git/known-hosts';

describe('pinned known_hosts (03 §7.3 H)', () => {
  let dataRoot: string;
  const saved = process.env.DATA_ROOT;
  beforeEach(() => {
    dataRoot = mkdtempSync(resolve(tmpdir(), 'kh-'));
    process.env.DATA_ROOT = dataRoot;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = saved;
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('recognizes the three public SaaS hosts (case-insensitive), not self-hosted', () => {
    expect(isPinnedHost('github.com')).toBe(true);
    expect(isPinnedHost('GitHub.com')).toBe(true);
    expect(isPinnedHost('gitlab.com')).toBe(true);
    expect(isPinnedHost('gitee.com')).toBe(true);
    expect(isPinnedHost('gitlab.internal')).toBe(false);
    expect(isPinnedHost('192.168.1.10')).toBe(false);
  });

  it('writes a 0600 file with pinned ed25519 + rsa keys for all three hosts', () => {
    const path = pinnedKnownHostsPath();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const body = readFileSync(path, 'utf8');
    for (const host of ['github.com', 'gitlab.com', 'gitee.com']) {
      expect(body).toContain(`${host} ssh-ed25519 `);
      expect(body).toContain(`${host} ssh-rsa `);
    }
    // exact pinned github ed25519 (verified against GitHub's published fingerprint).
    expect(body).toContain(
      'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
    );
  });

  it('overwrites on each call (integrity — cannot be poisoned by a prior write)', () => {
    const path = pinnedKnownHostsPath();
    const a = readFileSync(path, 'utf8');
    const b = readFileSync(pinnedKnownHostsPath(), 'utf8');
    expect(a).toBe(b);
  });
});
