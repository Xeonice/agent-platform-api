import { describe, expect, it } from 'vitest';
import { asCredentialId } from '@platform/shared-kernel';
import { Credential } from '../../../packages/modules/credential/src/domain/entities/credential.entity';
import { MaskedIdentifier } from '../../../packages/modules/credential/src/domain/value-objects/masked-identifier.vo';
import { EncryptedBlob } from '../../../packages/modules/credential/src/domain/value-objects/encrypted-blob.vo';
import { CredentialMapper } from '../../../packages/modules/credential/src/application/dto/credential.mapper';

describe('Git credential read model never serializes plaintext or ciphertext', () => {
  it.each(['git-ssh-key', 'git-https-token'] as const)(
    'projects only approved fields for %s',
    (obtainedVia) => {
      const secret = 'synthetic-private-material-DO-NOT-RETURN';
      const masked =
        obtainedVia === 'git-ssh-key'
          ? MaskedIdentifier.forSshPrivateKey(Buffer.from(secret))
          : MaskedIdentifier.forToken(Buffer.from(secret));
      const credential = Credential.createGit({
        id: asCredentialId('credential'),
        obtainedVia,
        masked,
        allowedHosts: ['git.example.test'],
        metadata: {
          provider: 'gitea',
          knownHosts: [
            {
              host: 'git.example.test',
              fingerprint: 'SHA256:public',
              keyType: 'ssh-ed25519',
              firstSeenAt: '2026-10-05T00:00:00Z',
            },
          ],
        },
        secret: new EncryptedBlob(
          'synthetic-ciphertext',
          'synthetic-iv',
          'synthetic-tag',
          'synthetic-key-id',
        ),
        now: new Date('2026-10-05T00:00:00Z'),
      });
      const dto = CredentialMapper.toMaskedGit(credential);
      const serialized = JSON.stringify(dto);
      expect(Object.keys(dto).sort()).toEqual([
        'allowedHosts',
        'createdAt',
        'id',
        'kind',
        'knownHosts',
        'lastUsedAt',
        'maskedIdentifier',
        'platform',
        'type',
      ]);
      expect(dto.allowedHosts).toEqual(['git.example.test']);
      expect(dto.knownHosts?.[0].host).toBe('git.example.test');
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('synthetic-ciphertext');
      expect(serialized).not.toContain('synthetic-key-id');
      if (obtainedVia === 'git-ssh-key') expect(dto.maskedIdentifier).toMatch(/^SHA256:/);
      else expect(dto.maskedIdentifier).toBe('…TURN');
    },
  );
});
