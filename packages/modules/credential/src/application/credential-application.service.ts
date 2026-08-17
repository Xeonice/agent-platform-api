import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CLOCK, EVENT_BUS, ID_GENERATOR, UNIT_OF_WORK, asCredentialId } from '@platform/shared-kernel';
import type { Clock, EventBus, IdGenerator, UnitOfWork } from '@platform/shared-kernel';
import type {
  CreateGitCredentialInput,
  GitTestRequestInput,
  GitTestResult,
  MaskedGitCredential,
  StoreGitCredentialResult,
} from '@platform/contracts';
import { Credential } from '../domain/entities/credential.entity';
import { CREDENTIAL_REPOSITORY } from '../domain/repositories/credential.repository';
import type { CredentialRepository } from '../domain/repositories/credential.repository';
import { CRYPTO_SERVICE, DecryptionError } from '../domain/ports/crypto.port';
import type { CryptoService } from '../domain/ports/crypto.port';
import { GIT_REMOTE_TESTER } from '../domain/ports/git-remote-tester.port';
import type { GitRemoteTester } from '../domain/ports/git-remote-tester.port';
import { GIT_AUTH_MATERIALIZER } from '../domain/ports/git-auth-materializer.port';
import type { GitAuthMaterializer, MaterializedGitAuth } from '../domain/ports/git-auth-materializer.port';
import { SecretMaterial } from '../domain/value-objects/secret-material.vo';
import { MaskedIdentifier } from '../domain/value-objects/masked-identifier.vo';
import { obtainedViaFromType } from '../domain/value-objects/obtained-via.vo';
import type { GitObtainedVia, GitPlatform } from '../domain/value-objects/obtained-via.vo';
import type { EncryptedBlob } from '../domain/value-objects/encrypted-blob.vo';
import { classifySshPrivateKey } from '../domain/services/passphrase.detector';
import { defaultPortForKind, hostAllowed, normalizeAllowedHost } from '../domain/services/host.util';
import { parseGitTarget } from '../domain/services/git-target.util';
import type { GitTargetScheme } from '../domain/services/git-target.util';
import { InvalidCredentialError, PassphraseProtectedKeyError } from '../domain/errors/credential-errors';
import { CredentialMapper } from './dto/credential.mapper';

/**
 * Protocol-agnostic git-credential application service (02 §1, 27 §5). REST injects
 * this. Store encrypts OUTSIDE the transaction (async crypto port), then in ONE
 * `UnitOfWork.run` revokes any same-protocol active credential and inserts the new
 * one ("更换" = revoke-old + insert-new, I-CRD-5). Test reuses the SAME
 * `prepareGitAuth` path as clone (A2) via the facade adapter.
 */
@Injectable()
export class CredentialApplicationService {
  constructor(
    @Inject(CREDENTIAL_REPOSITORY) private readonly repo: CredentialRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CRYPTO_SERVICE) private readonly crypto: CryptoService,
    @Inject(GIT_REMOTE_TESTER) private readonly tester: GitRemoteTester,
    @Inject(GIT_AUTH_MATERIALIZER) private readonly materializer: GitAuthMaterializer,
  ) {}

  async storeGitCredential(input: CreateGitCredentialInput): Promise<StoreGitCredentialResult> {
    const obtainedVia = obtainedViaFromType(input.type);
    const allowedHosts = normalizeHosts(input.allowedHosts, obtainedVia);
    if (obtainedVia === 'git-https-token' && allowedHosts.length === 0) {
      throw new BadRequestException(
        'https-token requires a non-empty allowedHosts whitelist (I-CRD-8)',
      );
    }

    const secret = SecretMaterial.fromUtf8(input.secret);
    try {
      // I-CRD-6: reject passphrase-protected SSH keys (deny-by-default).
      if (obtainedVia === 'git-ssh-key') {
        const verdict = secret.use((buf) => classifySshPrivateKey(buf));
        if (!verdict.unprotected) {
          throw new PassphraseProtectedKeyError(verdict.reason);
        }
      }
      const masked = secret.use((buf) =>
        obtainedVia === 'git-ssh-key'
          ? MaskedIdentifier.forSshPrivateKey(buf)
          : MaskedIdentifier.forToken(buf),
      );
      const encrypted = await this.crypto.encrypt(secret); // async, outside the tx

      const now = this.clock.now();
      const id = asCredentialId(this.ids.next());
      const cred = Credential.createGit({
        id,
        obtainedVia,
        masked,
        allowedHosts,
        metadata: input.platform ? { provider: input.platform } : null,
        secret: encrypted,
        now,
      });

      // "更换" (I-CRD-5): revoke any same-protocol active credential + insert the
      // new one in the SAME transaction (else it collides with uq_cred_git_active).
      const existing = (await this.repo.listGitCredentials(false)).find(
        (c) => c.obtainedVia === obtainedVia && !c.isRevoked(),
      );
      this.uow.run((tx) => {
        if (existing) this.repo.revokeAndEraseSync(tx, existing.id, now);
        this.repo.saveSync(tx, cred);
        this.events.publishInTx(tx, cred.pullEvents());
      });
      return { id: id as string, maskedIdentifier: masked.toString() };
    } catch (e) {
      throw this.mapDomainError(e);
    } finally {
      secret.zeroize();
    }
  }

  async listGitCredentials(): Promise<MaskedGitCredential[]> {
    const creds = await this.repo.listGitCredentials(false);
    return creds.map((c) => CredentialMapper.toMaskedGit(c));
  }

  async revokeGitCredential(id: string): Promise<void> {
    const cred = await this.repo.findById(asCredentialId(id));
    if (!cred || cred.kind !== 'git') {
      throw new NotFoundException(`git credential ${id} not found`);
    }
    if (cred.isRevoked()) return; // idempotent
    const now = this.clock.now();
    cred.revoke(now);
    this.uow.run((tx) => {
      this.repo.revokeAndEraseSync(tx, cred.id, now);
      this.events.publishInTx(tx, cred.pullEvents());
    });
  }

  /**
   * Test a git credential (03 §7.4, coordinator ruling). `inline` materializes a
   * not-yet-stored pasted secret TRANSIENTLY (encrypt in memory → same materializer
   * path → NEVER written to the vault); `stored` decrypts an existing credential.
   * Both: host ∈ allowedHosts, resolve+pin/non-internal (in the materializer), `git
   * ls-remote --exit-code` 15s, dispose() in finally, and NEVER return a ref list.
   */
  async testGitCredential(input: GitTestRequestInput): Promise<GitTestResult> {
    const resolved = await this.resolveTestSource(input);
    const { kind, allowedHosts, blob, platform } = resolved;

    const target = resolveTestTarget(input.repoUrl, kind, allowedHosts, platform);
    if (!target) {
      return {
        ok: false,
        errorCode: 'CLONE_FAILED_NETWORK',
        message: 'unsupported or missing repo URL',
      };
    }

    // host ∈ allowedHosts (I-CRD-8 / C3). SSH with no recorded hosts relies on the
    // RepoUrl SSRF + resolve+pin, so it is allowed; a token is always checked.
    const mustCheckHost = kind === 'git-https-token' || allowedHosts.length > 0;
    if (mustCheckHost && !hostAllowed(target.host, allowedHosts)) {
      return {
        ok: false,
        errorCode: 'CLONE_FAILED_PERMISSION',
        message: 'target host is not in the credential allowedHosts whitelist',
      };
    }

    let auth: MaterializedGitAuth;
    try {
      auth = await this.materializer.materialize({
        obtainedVia: kind,
        secret: blob,
        allowedHosts,
        host: target.host,
        scheme: target.scheme,
      });
    } catch (e) {
      if (e instanceof DecryptionError) {
        return { ok: false, errorCode: 'CLONE_FAILED_PERMISSION', message: 'credential could not be decrypted' };
      }
      throw e;
    }
    try {
      return await this.tester.lsRemote({
        url: target.url,
        env: auth.env,
        gitSshCommand: auth.gitSshCommand,
      });
    } finally {
      await auth.dispose();
    }
  }

  /**
   * Resolve the test source into `{ kind, allowedHosts, blob, platform }`. `inline`
   * encrypts the pasted secret in memory (never persisted); `stored` loads + asserts
   * the vault credential.
   */
  private async resolveTestSource(input: GitTestRequestInput): Promise<{
    kind: GitObtainedVia;
    allowedHosts: string[];
    blob: EncryptedBlob;
    platform?: GitPlatform;
  }> {
    if (input.source === 'inline') {
      const kind = obtainedViaFromType(input.type);
      const allowedHosts = normalizeHosts(input.allowedHosts, kind);
      if (kind === 'git-https-token' && allowedHosts.length === 0) {
        throw new BadRequestException('https-token requires a non-empty allowedHosts whitelist');
      }
      const secret = SecretMaterial.fromUtf8(input.secret);
      try {
        if (kind === 'git-ssh-key') {
          const verdict = secret.use((buf) => classifySshPrivateKey(buf));
          if (!verdict.unprotected) throw new PassphraseProtectedKeyError(verdict.reason);
        }
        const blob = await this.crypto.encrypt(secret); // in-memory only, NEVER stored
        return { kind, allowedHosts, blob, platform: input.platform };
      } catch (e) {
        throw this.mapDomainError(e);
      } finally {
        secret.zeroize();
      }
    }
    // stored
    const cred = await this.repo.findById(asCredentialId(input.credentialId));
    if (!cred || cred.kind !== 'git') {
      throw new NotFoundException(`git credential ${input.credentialId} not found`);
    }
    let blob: EncryptedBlob;
    try {
      blob = cred.assertUsable();
    } catch {
      throw new NotFoundException(`git credential ${input.credentialId} is revoked`);
    }
    return { kind: cred.obtainedVia, allowedHosts: cred.allowedHosts, blob, platform: cred.metadata?.provider };
  }

  private mapDomainError(e: unknown): unknown {
    if (e instanceof InvalidCredentialError) return new BadRequestException(e.message);
    return e;
  }
}

/** Normalise + dedup allowedHosts into canonical authorities for the credential kind. */
function normalizeHosts(hosts: string[], kind: GitObtainedVia): string[] {
  const dflt = defaultPortForKind(kind);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hosts) {
    const n = normalizeAllowedHost(h, dflt);
    if (n.length === 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Resolve the probe target `{ host, url }`. With a repoUrl, use its host + the URL
 * verbatim (the credential's kind still drives materialize); without one, derive a
 * default loop-back probe from allowedHosts[0] or the platform host (03 §7.4).
 */
function resolveTestTarget(
  repoUrl: string | undefined,
  kind: GitObtainedVia,
  allowedHosts: string[],
  platform: GitPlatform | undefined,
): { host: string; url: string; scheme: GitTargetScheme } | null {
  if (repoUrl) {
    const parsed = parseGitTarget(repoUrl);
    return parsed ? { host: parsed.host, url: repoUrl, scheme: parsed.scheme } : null;
  }
  // allowedHosts[0] is already a canonical authority (may carry a non-default port).
  const host = allowedHosts.length > 0 ? allowedHosts[0] : hostForPlatform(platform);
  if (!host) return null;
  // No repoUrl → default probe. A derived token probe assumes https (the safe default
  // for a bare authority); an SSH probe assumes ssh.
  const isToken = kind === 'git-https-token';
  const url = isToken ? `https://${host}/` : `ssh://git@${host}/`;
  return { host, url, scheme: isToken ? 'https' : 'ssh' };
}

/** Map a platform hint to its default probe host. */
function hostForPlatform(platform: GitPlatform | undefined): string | null {
  switch (platform) {
    case 'github':
      return 'github.com';
    case 'gitlab':
      return 'gitlab.com';
    case 'gitee':
      return 'gitee.com';
    default:
      return null;
  }
}
