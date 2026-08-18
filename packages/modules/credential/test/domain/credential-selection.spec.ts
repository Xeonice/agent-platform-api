import { describe, it, expect } from 'vitest';
import { asCredentialId } from '@platform/shared-kernel';
import { Credential } from '../../src/domain/entities/credential.entity';
import { CredentialSelectionService } from '../../src/domain/services/credential-selection.domain-service';
import { EncryptedBlob } from '../../src/domain/value-objects/encrypted-blob.vo';
import { MaskedIdentifier } from '../../src/domain/value-objects/masked-identifier.vo';
import type { GitObtainedVia } from '../../src/domain/value-objects/obtained-via.vo';

function makeCred(id: string, via: GitObtainedVia, now: Date): Credential {
  return Credential.createGit({
    id: asCredentialId(id),
    obtainedVia: via,
    masked: MaskedIdentifier.rehydrate('SHA256:x'),
    allowedHosts: via === 'git-https-token' ? ['github.com'] : [],
    secret: new EncryptedBlob('b', 'i', 't', 'k'),
    now,
  });
}

describe('CredentialSelectionService.forKind (23 §8.5, A3 — eats the enum)', () => {
  const t0 = new Date('2026-08-01T00:00:00Z');
  const t1 = new Date('2026-08-02T00:00:00Z');

  it('selects the active credential of the requested kind', () => {
    const ssh = makeCred('c-ssh', 'git-ssh-key', t0);
    const https = makeCred('c-https', 'git-https-token', t0);
    expect(CredentialSelectionService.forKind('git-ssh-key', [ssh, https])).toBe(ssh.id);
    expect(CredentialSelectionService.forKind('git-https-token', [ssh, https])).toBe(https.id);
  });

  it('returns null when no credential of that kind exists', () => {
    const ssh = makeCred('c-ssh', 'git-ssh-key', t0);
    expect(CredentialSelectionService.forKind('git-https-token', [ssh])).toBeNull();
    expect(CredentialSelectionService.forKind('git-https-token', [])).toBeNull();
  });

  it('ignores revoked credentials and prefers the most recent', () => {
    const older = makeCred('c-old', 'git-https-token', t0);
    const newer = makeCred('c-new', 'git-https-token', t1);
    older.revoke(t1);
    expect(CredentialSelectionService.forKind('git-https-token', [older, newer])).toBe(newer.id);
    newer.revoke(t1);
    expect(CredentialSelectionService.forKind('git-https-token', [older, newer])).toBeNull();
  });
});
