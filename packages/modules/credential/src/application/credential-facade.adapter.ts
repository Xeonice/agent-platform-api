import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, UNIT_OF_WORK } from '@platform/shared-kernel';
import type { Clock, UnitOfWork } from '@platform/shared-kernel';
import { CredentialPreparationError } from '@platform/contracts';
import type { CredentialFacade, GitAuthContext, GitRemoteScheme } from '@platform/contracts';
import { CREDENTIAL_REPOSITORY } from '../domain/repositories/credential.repository';
import type { CredentialRepository } from '../domain/repositories/credential.repository';
import { GIT_AUTH_MATERIALIZER } from '../domain/ports/git-auth-materializer.port';
import type { GitAuthMaterializer } from '../domain/ports/git-auth-materializer.port';
import { CredentialSelectionService } from '../domain/services/credential-selection.domain-service';
import { hostAllowed } from '../domain/services/host.util';
import { DecryptionError } from '../domain/ports/crypto.port';
import { CredentialRevokedError } from '../domain/errors/credential-errors';
import type { GitObtainedVia } from '../domain/value-objects/obtained-via.vo';
import type { EncryptedBlob } from '../domain/value-objects/encrypted-blob.vo';

/**
 * Implements the cross-context `CredentialFacade` (contracts, A2). `prepareGitAuth`
 * is the ONE path Git-credential USE takes — the project clone workflow and the
 * intra-context test endpoint both go through it:
 *   ① forKind selects the effective credential (throws NO_CREDENTIAL if none)
 *   ② host ∈ allowedHosts is enforced for tokens (I-CRD-8 → HOST_NOT_ALLOWED)
 *   ③ credential/infrastructure decrypts + materializes into an opaque handle
 * The plaintext NEVER leaves infrastructure; the caller only ever holds the handle.
 */
@Injectable()
export class CredentialFacadeAdapter implements CredentialFacade {
  constructor(
    @Inject(CREDENTIAL_REPOSITORY) private readonly repo: CredentialRepository,
    @Inject(GIT_AUTH_MATERIALIZER) private readonly materializer: GitAuthMaterializer,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async prepareGitAuth(
    kind: GitObtainedVia,
    host: string,
    scheme: GitRemoteScheme,
  ): Promise<GitAuthContext> {
    const candidates = await this.repo.listGitCredentials(false);
    const selectedId = CredentialSelectionService.forKind(kind, candidates);
    if (!selectedId) {
      throw new CredentialPreparationError('NO_CREDENTIAL', `no ${kind} credential configured`);
    }
    const cred = candidates.find((c) => c.id === selectedId);
    if (!cred) {
      throw new CredentialPreparationError('NO_CREDENTIAL', `no ${kind} credential configured`);
    }

    // I-CRD-8 / C: a token must never be sent to a host outside its whitelist. SSH
    // host-checking relies mainly on RepoUrl SSRF + resolve+pin, so an SSH key with
    // no recorded hosts is allowed; if it DOES record hosts, honour them.
    const mustCheckHost = kind === 'git-https-token' || cred.allowedHosts.length > 0;
    if (mustCheckHost && !hostAllowed(host, cred.allowedHosts)) {
      throw new CredentialPreparationError(
        'HOST_NOT_ALLOWED',
        `host ${host} is not in the credential's allowedHosts`,
      );
    }

    let blob: EncryptedBlob;
    try {
      blob = cred.assertUsable();
    } catch (e) {
      if (e instanceof CredentialRevokedError) {
        throw new CredentialPreparationError('NO_CREDENTIAL', 'credential is revoked');
      }
      throw e;
    }

    let context: GitAuthContext;
    try {
      context = await this.materializer.materialize({
        obtainedVia: cred.obtainedVia,
        secret: blob,
        allowedHosts: cred.allowedHosts,
        host,
        scheme,
      });
    } catch (e) {
      // 05 §4.2: an authTag mismatch / unavailable key presents as revoked (not 500).
      if (e instanceof DecryptionError) {
        throw new CredentialPreparationError('NO_CREDENTIAL', 'credential could not be decrypted');
      }
      throw e;
    }

    // Best-effort: record "last used" (P21-3 §10.1). Never fail the clone over it.
    try {
      this.uow.run((tx) => this.repo.touchLastUsedSync(tx, selectedId, this.clock.now()));
    } catch {
      /* ignore */
    }
    return context;
  }
}
