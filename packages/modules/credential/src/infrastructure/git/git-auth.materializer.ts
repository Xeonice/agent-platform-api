import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { GitAuthContext } from '@platform/contracts';
import { CRYPTO_SERVICE } from '../../domain/ports/crypto.port';
import type { CryptoService } from '../../domain/ports/crypto.port';
import type {
  GitAuthMaterializer,
  MaterializeGitAuthInput,
} from '../../domain/ports/git-auth-materializer.port';
import type { SecretMaterial } from '../../domain/value-objects/secret-material.vo';
import { isPinnedHost, pinnedKnownHostsPath, platformKnownHostsPath } from './known-hosts';
import { gitKeysBaseDir } from './keyfile-dir';

/**
 * Git auth materializer (docs/backend/03 §7.3, A1). Decrypts the secret and turns
 * it into an opaque `GitAuthContext` — the plaintext NEVER leaves this file.
 *
 *  - HTTPS token: the token travels ONLY in env `$GIT_TOKEN`; a per-host credential
 *    helper is delivered via git's env-config mechanism (GIT_CONFIG_COUNT/KEY/VALUE)
 *    so it never appears in a URL or argv. `!f(){ echo username=x-access-token; echo
 *    password=$GIT_TOKEN; }; f` is set for EACH allowed host (URL-scoped).
 *  - SSH key: written to a `wx`+0600 keyfile inside a fresh `mkdtemp` 0700 dir;
 *    `GIT_SSH_COMMAND` pins `-i <keyfile> -o IdentitiesOnly=yes` plus host-key
 *    verification: for a PINNED SaaS host → `UserKnownHostsFile=<pinned>` +
 *    `StrictHostKeyChecking=yes` (a rebinding/MITM host key mismatch aborts the
 *    handshake before the key signs); for an unknown self-hosted host →
 *    `UserKnownHostsFile=<platform TOFU>` + `StrictHostKeyChecking=accept-new`.
 *    `dispose()` removes the whole dir.
 *
 * THREAT MODEL (03 §7.3 C4): where a credential may be sent is governed by
 * `allowedHosts` (checked in the facade). We do NOT ban private/internal IPs —
 * internal self-hosted git is a core use case on a single-machine deploy.
 * Rebinding/MITM is closed by TLS cert validation (HTTPS) and pinned known_hosts
 * (SSH SaaS), not by refusing private addresses.
 */
const HTTPS_HELPER = '!f(){ echo username=x-access-token; echo password=$GIT_TOKEN; }; f';

@Injectable()
export class FsGitAuthMaterializer implements GitAuthMaterializer {
  private readonly logger = new Logger(FsGitAuthMaterializer.name);

  constructor(@Inject(CRYPTO_SERVICE) private readonly crypto: CryptoService) {}

  async materialize(input: MaterializeGitAuthInput): Promise<GitAuthContext> {
    const secret = await this.crypto.decrypt(input.secret); // throws DecryptionError
    try {
      return input.obtainedVia === 'git-ssh-key'
        ? await this.materializeSsh(secret, input.host.trim().toLowerCase())
        : this.materializeHttps(secret, input.allowedHosts, input.scheme, input.host);
    } finally {
      secret.zeroize();
    }
  }

  private async materializeSsh(secret: SecretMaterial, host: string): Promise<GitAuthContext> {
    const base = gitKeysBaseDir();
    await mkdir(base, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(base, 'k-'));
    const keyfile = join(dir, 'id');
    // `wx` = exclusive create (fail if exists) + do not follow an existing symlink;
    // the dir is fresh + random + 0700 so the attack surface is already minimal.
    const handle = await open(keyfile, 'wx', 0o600);
    try {
      const pem = secret.use((buf) => ensureTrailingNewline(buf));
      await handle.writeFile(pem);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Pinned SaaS host → StrictHostKeyChecking=yes against the pinned known_hosts
    // (a MITM/rebinding host-key mismatch aborts BEFORE the key signs). Unknown
    // self-hosted host → accept-new TOFU against the platform-private file (H).
    const pinned = isPinnedHost(host);
    const knownHosts = pinned ? pinnedKnownHostsPath() : platformKnownHostsPath();
    const strict = pinned ? 'yes' : 'accept-new';
    // `-F /dev/null` makes the invocation HERMETIC: ignore the ambient ~/.ssh/config
    // so it cannot rewrite the host (e.g. github.com → ssh.github.com:443, which would
    // bypass the pin), inject a ProxyCommand, or add an ambient IdentityFile. We supply
    // everything explicitly (-i + IdentitiesOnly + our known_hosts).
    const gitSshCommand = `ssh -F /dev/null -i "${keyfile}" -o IdentitiesOnly=yes -o UserKnownHostsFile="${knownHosts}" -o StrictHostKeyChecking=${strict}`;
    return {
      env: {},
      gitSshCommand,
      dispose: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  private materializeHttps(
    secret: SecretMaterial,
    allowedHosts: string[],
    scheme: MaterializeGitAuthInput['scheme'],
    targetHost: string,
  ): GitAuthContext {
    // git credential matching is scheme+AUTHORITY sensitive (03 §7.3 C4). The helper
    // key MUST carry the remote's ACTUAL scheme, else a plaintext `http://` internal
    // remote never matches a `credential.https://…` helper and the token is dropped.
    // Only http/https reach a credential helper; `git://` (anon) carries no auth, so
    // it and any unrecognised value fall back to `https` (the historical default).
    const helperScheme = scheme === 'http' ? 'http' : 'https';
    // http token = cleartext over the wire. We do NOT block it (internal trusted-network
    // git is a core use case, C4 "不禁私网"), but warn loudly for operator awareness.
    if (helperScheme === 'http') {
      this.logger.warn(
        `credential over plaintext http to ${targetHost.trim().toLowerCase()} — ` +
          'token sent in cleartext; ensure this is a trusted network',
      );
    }
    const token = secret.use((buf) => buf.toString('utf8').trim());
    const env: Record<string, string> = { GIT_TOKEN: token };
    // allowedHosts are already canonical authorities (host, or host:port for a
    // non-default port) — the helper is scoped per authority to match git's
    // port-sensitive credential lookup (03 §7.3 C4). Just dedup/lowercase.
    const hosts = [...new Set(allowedHosts.map((h) => h.trim().toLowerCase()))];
    // HERMETIC (the HTTPS twin of SSH's `-F /dev/null`): FIRST reset the credential
    // helper chain with an empty global `credential.helper=` (index 0). This
    // neutralizes any ambient/built-in helper — notably macOS Apple Git's compiled-in
    // osxkeychain — so git NEVER (a) reads a cached token from the host keychain, nor
    // (b) runs `credential approve` to WRITE our vault token INTO the keychain after a
    // successful clone (a hygiene leak that would survive vault revocation). Our
    // host-scoped helpers come AFTER, so they are the only ones that fire.
    env.GIT_CONFIG_KEY_0 = 'credential.helper';
    env.GIT_CONFIG_VALUE_0 = '';
    hosts.forEach((host, i) => {
      env[`GIT_CONFIG_KEY_${i + 1}`] = `credential.${helperScheme}://${host}.helper`;
      env[`GIT_CONFIG_VALUE_${i + 1}`] = HTTPS_HELPER;
    });
    env.GIT_CONFIG_COUNT = String(hosts.length + 1);
    return {
      env,
      dispose: async () => {
        // No files on disk; drop the token reference so it cannot linger.
        env.GIT_TOKEN = '';
        await Promise.resolve();
      },
    };
  }
}

/** SSH keyfiles must end in a newline or ssh rejects the key. */
function ensureTrailingNewline(buf: Buffer): Buffer {
  return buf.length > 0 && buf[buf.length - 1] === 0x0a
    ? buf
    : Buffer.concat([buf, Buffer.from('\n')]);
}
