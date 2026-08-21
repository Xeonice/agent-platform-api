import { describe, it, expect } from 'vitest';
import type { Clock } from '@platform/shared-kernel';
import { RuntimeCredentialService } from '../../src/application/runtime-credential.service';
import { Credential } from '../../src/domain/entities/credential.entity';
import { EncryptedBlob } from '../../src/domain/value-objects/encrypted-blob.vo';
import { MaskedIdentifier } from '../../src/domain/value-objects/masked-identifier.vo';
import type { CredentialId } from '@platform/shared-kernel';
import type { CredentialRepository } from '../../src/domain/repositories/credential.repository';

const NOW = new Date(1_000_000_000);
const clock: Clock = { now: () => new Date(NOW.getTime()) };

function cred(
  id: string,
  obtainedVia: 'oauth-device' | 'api-key',
  opts: { expiresAt?: Date; masked?: string } = {},
) {
  return Credential.createRuntime({
    id: id as CredentialId,
    runtimeId: 'codex',
    obtainedVia,
    masked: MaskedIdentifier.rehydrate(opts.masked ?? 'm'),
    secret: new EncryptedBlob('b', 'iv', 't', 'k'),
    now: new Date(0),
    expiresAt: opts.expiresAt ?? null,
  });
}

/** Minimal repo double exposing only what listSummaries reads. */
function repoWith(list: Credential[]): CredentialRepository {
  return {
    listByRuntime: async () => list,
    findById: async () => null,
    listGitCredentials: async () => [],
    listRefreshDue: async () => [],
    listExpiringBefore: async () => [],
    saveSync() {},
    revokeAndEraseSync() {},
    touchLastUsedSync() {},
    refreshSync() {},
    recordRefreshFailureSync() {},
  };
}

function service(list: Credential[]): RuntimeCredentialService {
  // only `repo` + `clock` are exercised by listSummaries.
  return new RuntimeCredentialService(
    repoWith(list),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    clock,
    {} as never,
    undefined,
    undefined,
  );
}

describe('RuntimeCredentialService.listSummaries (P21-3 §3 per-mode cards)', () => {
  it('emits one entry per CONFIGURED mode, each with its own credentialId', async () => {
    const account = cred('acc', 'oauth-device', {
      expiresAt: new Date(NOW.getTime() + 40 * 864e5),
    });
    const apikey = cred('key', 'api-key', { masked: 'sk-...ab12' });
    const rows = await service([account, apikey]).listSummaries('codex');
    expect(rows).toHaveLength(2);
    const byMode = Object.fromEntries(rows.map((r) => [r.mode, r]));
    expect(byMode.account.credentialId).toBe('acc');
    expect(byMode.account.status).toBe('ok');
    expect(byMode['api-key'].credentialId).toBe('key');
    expect(byMode['api-key'].maskedIdentifier).toBe('sk-...ab12');
    expect(byMode['api-key'].expiresAt).toBeUndefined();
  });

  it('omits an unconfigured mode (only account present → one row)', async () => {
    const rows = await service([cred('acc', 'oauth-device')]).listSummaries('codex');
    expect(rows.map((r) => r.mode)).toEqual(['account']);
  });

  it('derives expiring/expired status from expiry', async () => {
    const expiring = cred('e', 'oauth-device', { expiresAt: new Date(NOW.getTime() + 3 * 864e5) });
    const [row] = await service([expiring]).listSummaries('codex');
    expect(row.status).toBe('expiring');
  });
});
