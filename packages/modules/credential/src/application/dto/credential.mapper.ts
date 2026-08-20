import type { MaskedGitCredential } from '@platform/contracts';
import type { Credential } from '../../domain/entities/credential.entity';
import { typeFromObtainedVia } from '../../domain/value-objects/obtained-via.vo';
import type { GitObtainedVia } from '../../domain/value-objects/obtained-via.vo';

/**
 * Mapper — the ONLY place domain ↔ masked wire DTO conversion happens for git
 * credentials (28 §4). NEVER projects the private key / token (I-CRD-2); only the
 * masked identifier, the non-sensitive allowedHosts and known_hosts fingerprints.
 */
export const CredentialMapper = {
  toMaskedGit(cred: Credential): MaskedGitCredential {
    return {
      id: cred.id as string,
      kind: 'git',
      type: typeFromObtainedVia(cred.obtainedVia as GitObtainedVia),
      maskedIdentifier: cred.masked.toString(),
      platform: cred.metadata?.provider,
      allowedHosts: cred.allowedHosts,
      knownHosts: cred.metadata?.knownHosts,
      lastUsedAt: cred.lastUsedAt ? cred.lastUsedAt.toISOString() : null,
      createdAt: cred.issuedAt.toISOString(),
    };
  },
};
