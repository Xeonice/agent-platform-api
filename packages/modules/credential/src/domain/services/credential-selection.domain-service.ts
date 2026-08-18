import type { CredentialId } from '@platform/shared-kernel';
import type { Credential } from '../entities/credential.entity';
import type { GitObtainedVia } from '../value-objects/obtained-via.vo';

/**
 * CredentialSelectionService (docs/backend/23 §8.5). `forKind` picks the effective
 * git credential by `obtained_via` from a pre-fetched candidate set.
 *
 * PURE (A3): it eats the `kind` ENUM, NOT project's `RepoUrl` VO — importing
 * `project/domain` from `credential/domain` would break the boundaries rules. The
 * `kind` is computed by `RepoUrl.credentialKind()` on the project side and passed
 * across the facade. At most one non-revoked credential exists per `obtained_via`
 * (I-CRD-5), so this returns that one (the most recent if several are supplied).
 */
export const CredentialSelectionService = {
  forKind(kind: GitObtainedVia, candidates: Credential[]): CredentialId | null {
    const active = candidates
      .filter((c) => c.kind === 'git' && c.obtainedVia === kind && !c.isRevoked())
      .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
    return active.length > 0 ? active[0].id : null;
  },
};
