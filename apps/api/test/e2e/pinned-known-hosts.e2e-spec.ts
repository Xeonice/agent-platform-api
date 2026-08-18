import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { pinnedKnownHostsPath } from '../../../../packages/modules/credential/src/infrastructure/git/known-hosts';

/**
 * S3 ACCEPTANCE for pinned known_hosts (03 §7.3 H): proves the PIN MECHANISM
 * really rejects a mismatched host key BEFORE any auth. Uses a real `ssh` to a
 * real SaaS host (github.com).
 *
 * NETWORK-GATED: because github's real host key can rotate and public reachability
 * flaps, this suite would otherwise make the MAIN CI pipeline flaky. It runs ONLY
 * when `RUN_NETWORK_E2E=1` is set (a dedicated/manual job); otherwise it skips
 * LOUDLY (never fake-passes). ssh + network are additionally required even when the
 * gate is on.
 *
 * A WRONG pinned github key + StrictHostKeyChecking=yes  → "Host key verification failed".
 * The REAL pinned file (shipped constants)               → host key ACCEPTED (fails
 *                                                           later at auth, which proves
 *                                                           the handshake passed the pin).
 */
function sshAvailable(): boolean {
  try {
    return spawnSync('ssh', ['-V'], { encoding: 'utf8' }).status !== null;
  } catch {
    return false;
  }
}
async function networkUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    await fetch('https://github.com', { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}
const networkGateOn = process.env.RUN_NETWORK_E2E === '1';
const ready = networkGateOn && sshAvailable() && (await networkUp());
if (!ready) {
  const reason = networkGateOn
    ? 'ssh or network unavailable'
    : 'network e2e disabled (set RUN_NETWORK_E2E=1 to run — it makes a real ssh to github.com)';
  console.warn(
    `\n[33m[pinned-known-hosts.e2e] SKIPPED — ${reason}. ` +
      'This proves SSH host-key pinning rejects a mismatched key. NOT fake-passed.[0m\n',
  );
}

// A syntactically valid ed25519 key that is NOT github's (it is gitlab's) — pinning
// this AS github.com must cause a host-key mismatch.
const WRONG_GITHUB_ED25519 =
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf\n';

function sshToGithub(knownHostsFile: string): string {
  const r = spawnSync(
    'ssh',
    [
      '-F',
      '/dev/null', // hermetic — ignore ambient ~/.ssh/config (as the platform does)
      '-o',
      'GlobalKnownHostsFile=/dev/null', // ignore /etc/ssh/ssh_known_hosts (CI runners pre-seed
      // github's real key there, which would bypass a wrong pin) — matches the platform SSH cmd
      '-o',
      `UserKnownHostsFile=${knownHostsFile}`,
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'HostKeyAlgorithms=ssh-ed25519',
      '-o',
      'ConnectTimeout=8',
      '-T',
      'git@github.com',
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

describe.skipIf(!ready)('SSH pinned known_hosts (03 §7.3 H)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'pin-e2e-'));
    process.env.DATA_ROOT = dir;
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a MISMATCHED pinned host key (verification fails before auth)', () => {
    const wrong = resolve(dir, 'wrong_known_hosts');
    writeFileSync(wrong, WRONG_GITHUB_ED25519, { mode: 0o600 });
    const out = sshToGithub(wrong);
    expect(out).toMatch(/Host key verification failed/i);
  }, 30_000);

  it('accepts the REAL shipped pinned github key (host key passes; only auth fails)', () => {
    const out = sshToGithub(pinnedKnownHostsPath());
    expect(out).not.toMatch(/Host key verification failed/i);
    // github rejects our (absent) key at AUTH — which means the host key was trusted.
    expect(out).toMatch(
      /Permission denied|successfully authenticated|does not provide shell access/i,
    );
  }, 30_000);
});
