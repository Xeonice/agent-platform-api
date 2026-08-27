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

  /**
   * 事件带的是**身份**（哪个 runtime、什么获取方式），不是**内容**。
   *
   * 为什么带：凭证没有用户起的名字，审计流的 `summary` 要「一行人话，直接上 UI」
   * （13 §2.8.2），只有 id 的话那一行是「保存凭证 3f9a77c1-…」，用户认不出是哪一个。
   * 而审计是历史快照——`revoke()` 会把密文擦成 `Erased`（I-CRD-3），回查当前库拿标识
   * 会让历史随现状漂移。
   *
   * ⛔ 为什么**只能**带这两个：05 §4 脱敏。`MaskedIdentifier.forToken` 是 token 的**末四位**
   * ——能反推凭证内容的东西，一律不许上事件、更不许进 summary。
   */
  it('CredentialStored 带 runtimeId + obtainedVia，且不夹带任何秘密材料', () => {
    const secret = new EncryptedBlob('CIPHERTEXT-BASE64', 'IV-BASE64', 'TAG-BASE64', 'key-1');
    const c = Credential.createRuntime({
      id: cid('id-token'),
      runtimeId: 'claude-code',
      obtainedVia: 'oauth-device',
      masked: MaskedIdentifier.forToken(Buffer.from('sk-ant-oat01-do-not-log-WXYZ')),
      secret,
      now: new Date(0),
    });
    const stored = c.pullEvents().find((e) => e.type === 'CredentialStored');
    expect(stored).toMatchObject({ runtimeId: 'claude-code', obtainedVia: 'oauth-device' });

    // ⚠️ 否定断言扫的是**整个事件**而不是某个具名字段：日后有人给事件加一个
    // `masked` / `secret` 字段（"排障方便"），这一条会红，而只断言"有 runtimeId"的
    // 写法照样绿。
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('WXYZ'); // token 末四位（MaskedIdentifier.forToken）
    expect(serialized).not.toContain('sk-ant');
    expect(serialized).not.toContain('CIPHERTEXT-BASE64');
    expect(serialized).not.toContain('key-1');
  });

  it('CredentialRevoked 也带同一份身份 —— 密文此刻已被擦成 Erased，回查库拿不到了', () => {
    const c = runtimeCred('rev', 'claude-code', 'api-key');
    c.pullEvents(); // drain create event
    c.revoke(new Date(1));
    const revoked = c.pullEvents().find((e) => e.type === 'CredentialRevoked');
    expect(revoked).toMatchObject({ runtimeId: 'claude-code', obtainedVia: 'api-key' });
    expect(JSON.stringify(revoked)).not.toContain('ab12'); // masked 的 token 末四位
  });

  it('git 凭证的 runtimeId 恒为 null（I-CRD-1），事件如实照搬', () => {
    const c = Credential.createGit({
      id: cid('git-1'),
      obtainedVia: 'git-ssh-key',
      masked,
      allowedHosts: ['github.com'],
      secret: blob,
      now: new Date(0),
    });
    expect(c.pullEvents().find((e) => e.type === 'CredentialStored')).toMatchObject({
      runtimeId: null,
      obtainedVia: 'git-ssh-key',
    });
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
