import { describe, it, expect, vi } from 'vitest';
import type { Clock, EventBus, IdGenerator, Tx, UnitOfWork } from '@platform/shared-kernel';
import type { RuntimeSettingsReader, RuntimeSettingsWriter } from '@platform/contracts';
import { RuntimeCredentialService } from '../../src/application/runtime-credential.service';
import { EncryptedBlob } from '../../src/domain/value-objects/encrypted-blob.vo';
import type { CryptoService } from '../../src/domain/ports/crypto.port';
import type { CredentialRepository } from '../../src/domain/repositories/credential.repository';

/**
 * I-RTS-3 (05 §4 mode switch / P0-2): `storeRuntimeCredential` seeds
 * `runtime_settings.active_auth_method` ONLY on first config (no settings row yet). A
 * re-store / refresh must NOT silently flip the user's chosen effective mode — the only
 * switch entry point is `PUT /auth-mode`.
 */
const NOW = new Date('2026-08-21T00:00:00.000Z');

function harness(existingMode: 'account' | 'api-key' | null) {
  const savedModes: Array<'account' | 'api-key'> = [];
  const repo: CredentialRepository = {
    listByRuntime: async () => [],
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

  const crypto: CryptoService = {
    encrypt: async () => new EncryptedBlob('b', 'iv', 't', 'k'),
    decrypt: async () => {
      throw new Error('not used');
    },
  };

  const uow: UnitOfWork = { run: (fn) => fn({} as Tx) };
  const events: EventBus = { publishInTx: () => {}, subscribe: () => {} };
  const clock: Clock = { now: () => NOW };
  const ids: IdGenerator = { next: () => 'cred-new' };

  const settingsWriter: RuntimeSettingsWriter = {
    saveSync: (_tx: Tx, _rt: string, mode: 'account' | 'api-key') => savedModes.push(mode),
  };
  const activeAuthMethod = vi.fn(async () => existingMode);
  const settingsReader: RuntimeSettingsReader = { activeAuthMethod };

  const service = new RuntimeCredentialService(
    repo,
    {} as never,
    crypto,
    {} as never,
    uow,
    events,
    clock,
    ids,
    settingsWriter,
    settingsReader,
  );
  return { service, savedModes, activeAuthMethod };
}

describe('RuntimeCredentialService.storeRuntimeCredential (I-RTS-3 mode seeding)', () => {
  it('FIRST config (no settings row) seeds active_auth_method to the stored mode', async () => {
    const h = harness(null);
    await h.service.storeRuntimeCredential({
      runtimeId: 'codex',
      obtainedVia: 'oauth-device', // → account
      maskedIdentifier: 'm',
      payload: { env: { X: 'y' } },
    });
    expect(h.savedModes).toEqual(['account']);
  });

  it('does NOT re-seed / flip the mode when settings already exist (re-store)', async () => {
    // user has explicitly selected api-key; storing an account credential must not
    // silently switch the effective mode back to account.
    const h = harness('api-key');
    await h.service.storeRuntimeCredential({
      runtimeId: 'codex',
      obtainedVia: 'oauth-device', // account-class
      maskedIdentifier: 'm',
      payload: { env: { X: 'y' } },
    });
    expect(h.activeAuthMethod).toHaveBeenCalledWith('codex');
    expect(h.savedModes).toEqual([]); // writer never touched
  });
});
