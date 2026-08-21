import { describe, it, expect } from 'vitest';
import type { CredentialId } from '@platform/shared-kernel';
import { Credential } from '../../src/domain/entities/credential.entity';
import { CredentialSelectionService } from '../../src/domain/services/credential-selection.domain-service';
import { EncryptedBlob } from '../../src/domain/value-objects/encrypted-blob.vo';
import { MaskedIdentifier } from '../../src/domain/value-objects/masked-identifier.vo';
import { InvalidCredentialError } from '../../src/domain/errors/credential-errors';

const blob = new EncryptedBlob('b', 'iv', 'tag', 'k');
const masked = MaskedIdentifier.rehydrate('sk-…ab12');
const cid = (v: string) => v as CredentialId;

function runtimeCred(
  id: string,
  runtimeId: string,
  obtainedVia: 'oauth-device' | 'api-key' | 'setup-token',
  now = new Date(0),
) {
  return Credential.createRuntime({
    id: cid(id),
    runtimeId,
    obtainedVia,
    masked,
    secret: blob,
    now,
  });
}

describe('Credential.createRuntime (I-CRD-1)', () => {
  it('derives mode from obtainedVia (api-key→api-key, else account)', () => {
    expect(runtimeCred('a', 'codex', 'oauth-device').mode).toBe('account');
    expect(runtimeCred('b', 'codex', 'setup-token').mode).toBe('account');
    expect(runtimeCred('c', 'codex', 'api-key').mode).toBe('api-key');
  });

  it('rejects an empty runtimeId', () => {
    expect(() => runtimeCred('d', '', 'oauth-device')).toThrow(InvalidCredentialError);
  });

  it('rejects a git obtainedVia on a runtime credential (I-CRD-1)', () => {
    expect(() =>
      Credential.createRuntime({
        id: cid('e'),
        runtimeId: 'codex',
        // @ts-expect-error — a git method is not a RuntimeAuthMethod
        obtainedVia: 'git-ssh-key',
        masked,
        secret: blob,
        now: new Date(0),
      }),
    ).toThrow(InvalidCredentialError);
  });

  it('raises CredentialStored on creation', () => {
    const c = runtimeCred('f', 'codex', 'oauth-device');
    expect(c.pullEvents().map((e) => e.type)).toContain('CredentialStored');
  });
});

describe('CredentialSelectionService.forRuntime (by MODE, not obtainedVia)', () => {
  it('selects the active credential of the effective mode', () => {
    const account = runtimeCred('acc', 'codex', 'oauth-device', new Date(10));
    const apikey = runtimeCred('key', 'codex', 'api-key', new Date(20));
    const candidates = [account, apikey];
    expect(CredentialSelectionService.forRuntime('codex', 'account', candidates)).toBe(account.id);
    expect(CredentialSelectionService.forRuntime('codex', 'api-key', candidates)).toBe(apikey.id);
  });

  it('account mode spans multiple obtainedVia (setup-token + oauth-device) — picks newest', () => {
    const older = runtimeCred('o', 'claude-code', 'setup-token', new Date(10));
    const newer = runtimeCred('n', 'claude-code', 'setup-token', new Date(30));
    expect(CredentialSelectionService.forRuntime('claude-code', 'account', [older, newer])).toBe(
      newer.id,
    );
  });

  it('returns null when the runtime/mode has no active credential', () => {
    const c = runtimeCred('x', 'codex', 'oauth-device');
    expect(CredentialSelectionService.forRuntime('codex', 'api-key', [c])).toBeNull();
    expect(CredentialSelectionService.forRuntime('other', 'account', [c])).toBeNull();
  });

  it('ignores revoked credentials', () => {
    const c = runtimeCred('r', 'codex', 'oauth-device');
    c.revoke(new Date(50));
    expect(CredentialSelectionService.forRuntime('codex', 'account', [c])).toBeNull();
  });
});
