import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { FsGitAuthMaterializer } from '../../src/infrastructure/git/git-auth.materializer';
import { EncryptedBlob } from '../../src/domain/value-objects/encrypted-blob.vo';
import { SecretMaterial } from '../../src/domain/value-objects/secret-material.vo';
import type { CryptoService } from '../../src/domain/ports/crypto.port';

// An unknown self-hosted host (→ accept-new); no network is touched by materialize.
const HOST = 'git.internal.example';
const blob = new EncryptedBlob('b', 'i', 't', 'k');

/** Fake crypto that returns a fixed plaintext, so materialize is exercised offline. */
function fakeCrypto(plain: string): CryptoService {
  return {
    encrypt: async () => blob,
    decrypt: async () => SecretMaterial.fromUtf8(plain),
  };
}

describe('FsGitAuthMaterializer (03 §7.3 — token only in env, keyfile 0600)', () => {
  let dataRoot: string;
  const savedDataRoot = process.env.DATA_ROOT;

  beforeEach(() => {
    dataRoot = mkdtempSync(resolve(tmpdir(), 'gitmat-'));
    process.env.DATA_ROOT = dataRoot;
  });
  afterEach(() => {
    if (savedDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = savedDataRoot;
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('HTTPS: token ONLY in env $GIT_TOKEN; helper is per-host and references $GIT_TOKEN', async () => {
    const TOKEN = 'ghp_SECRETTOKENVALUE1234';
    const mat = new FsGitAuthMaterializer(fakeCrypto(TOKEN));
    const ctx = await mat.materialize({
      obtainedVia: 'git-https-token',
      secret: blob,
      allowedHosts: ['github.com', 'git.example.com'],
      host: HOST,
      scheme: 'https',
    });

    expect(ctx.env.GIT_TOKEN).toBe(TOKEN);
    // hermetic: index 0 resets the helper chain (neutralizes ambient osxkeychain etc).
    expect(ctx.env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(ctx.env.GIT_CONFIG_VALUE_0).toBe('');
    // host-scoped helpers come AFTER the reset.
    expect(ctx.env.GIT_CONFIG_COUNT).toBe('3');
    expect(ctx.env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(ctx.env.GIT_CONFIG_KEY_2).toBe('credential.https://git.example.com.helper');
    // the helper script carries a REFERENCE to $GIT_TOKEN, never the token itself.
    expect(ctx.env.GIT_CONFIG_VALUE_1).toContain('$GIT_TOKEN');
    expect(ctx.env.GIT_CONFIG_VALUE_1).not.toContain(TOKEN);
    // no env value OTHER than GIT_TOKEN contains the raw token.
    for (const [k, v] of Object.entries(ctx.env)) {
      if (k !== 'GIT_TOKEN') expect(v).not.toContain(TOKEN);
    }
    expect(ctx.gitSshCommand).toBeUndefined();

    await ctx.dispose();
    expect(ctx.env.GIT_TOKEN).toBe(''); // token reference dropped
  });

  it('HTTPS: a non-default port is part of the helper scope (git ≥ 2.50 port-sensitive)', async () => {
    const mat = new FsGitAuthMaterializer(fakeCrypto('ghp_tok'));
    const ctx = await mat.materialize({
      obtainedVia: 'git-https-token',
      secret: blob,
      allowedHosts: ['git.company.com:8443'], // self-hosted GitLab on :8443
      host: HOST,
      scheme: 'https',
    });
    expect(ctx.env.GIT_CONFIG_KEY_0).toBe('credential.helper'); // reset first
    expect(ctx.env.GIT_CONFIG_KEY_1).toBe('credential.https://git.company.com:8443.helper');
    expect(ctx.env.GIT_CONFIG_COUNT).toBe('2');
  });

  it('http token: helper key is scheme=http so a plaintext http:// remote matches (C4)', async () => {
    // git credential matching is scheme+authority sensitive — a `credential.https://…`
    // helper would NOT fire for an `http://` remote, so the key MUST track the scheme.
    const mat = new FsGitAuthMaterializer(fakeCrypto('ghp_tok'));
    const ctx = await mat.materialize({
      obtainedVia: 'git-https-token',
      secret: blob,
      allowedHosts: ['git.internal:8080'], // plaintext internal git on :8080
      host: 'git.internal:8080',
      scheme: 'http',
    });
    expect(ctx.env.GIT_CONFIG_KEY_0).toBe('credential.helper'); // hermetic reset kept
    expect(ctx.env.GIT_CONFIG_VALUE_0).toBe('');
    // the ONLY difference from https: the helper key scheme is http.
    expect(ctx.env.GIT_CONFIG_KEY_1).toBe('credential.http://git.internal:8080.helper');
    expect(ctx.env.GIT_CONFIG_COUNT).toBe('2');
    // token still travels ONLY in $GIT_TOKEN, never inlined.
    expect(ctx.env.GIT_TOKEN).toBe('ghp_tok');
    expect(ctx.env.GIT_CONFIG_VALUE_1).toContain('$GIT_TOKEN');
  });

  it('unrecognised/anon scheme (git://) falls back to the https helper key', async () => {
    const mat = new FsGitAuthMaterializer(fakeCrypto('ghp_tok'));
    const ctx = await mat.materialize({
      obtainedVia: 'git-https-token',
      secret: blob,
      allowedHosts: ['git.example.com'],
      host: HOST,
      scheme: 'git',
    });
    expect(ctx.env.GIT_CONFIG_KEY_1).toBe('credential.https://git.example.com.helper');
  });

  it('SSH (unknown self-hosted host): keyfile wx+0600, accept-new TOFU; dispose removes dir', async () => {
    const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nKEYBYTES\n-----END OPENSSH PRIVATE KEY-----';
    const mat = new FsGitAuthMaterializer(fakeCrypto(KEY));
    const ctx = await mat.materialize({
      obtainedVia: 'git-ssh-key',
      secret: blob,
      allowedHosts: [],
      host: HOST,
    });

    expect(ctx.gitSshCommand).toContain('-F /dev/null'); // hermetic — ignore ambient ssh config
    expect(ctx.gitSshCommand).toContain('-o GlobalKnownHostsFile=/dev/null'); // ignore /etc/ssh known_hosts
    expect(ctx.gitSshCommand).toContain('-o IdentitiesOnly=yes');
    // unknown host → accept-new against the platform TOFU known_hosts.
    expect(ctx.gitSshCommand).toContain('-o StrictHostKeyChecking=accept-new');
    expect(ctx.gitSshCommand).toContain(
      `UserKnownHostsFile="${resolve(dataRoot, '.ssh', 'known_hosts')}"`,
    );
    expect(ctx.env.GIT_TOKEN).toBeUndefined();

    const keyfile = /-i "([^"]+)"/.exec(ctx.gitSshCommand ?? '')?.[1];
    expect(statSync(keyfile!).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyfile!, 'utf8')).toBe(`${KEY}\n`); // trailing newline appended
    expect(keyfile!.startsWith(resolve(dataRoot, '.gitkeys'))).toBe(true);

    await ctx.dispose();
    expect(existsSync(keyfile!)).toBe(false);
  });

  it('SSH (pinned SaaS host github.com): StrictHostKeyChecking=yes against the pinned file', async () => {
    const mat = new FsGitAuthMaterializer(
      fakeCrypto('-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----'),
    );
    const ctx = await mat.materialize({
      obtainedVia: 'git-ssh-key',
      secret: blob,
      allowedHosts: ['github.com'],
      host: 'github.com',
    });
    expect(ctx.gitSshCommand).toContain('-o StrictHostKeyChecking=yes');
    expect(ctx.gitSshCommand).toContain('-o GlobalKnownHostsFile=/dev/null'); // pin is the ONLY source
    const khFile = /UserKnownHostsFile="([^"]+)"/.exec(ctx.gitSshCommand ?? '')?.[1];
    expect(khFile).toBe(resolve(dataRoot, '.ssh', 'pinned_known_hosts'));
    // the pinned file really contains github's pinned ed25519 key.
    expect(readFileSync(khFile!, 'utf8')).toContain(
      'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
    );
    await ctx.dispose();
  });
});
