import { describe, it, expect } from 'vitest';
import { MaskedIdentifier } from '../../src/domain/value-objects/masked-identifier.vo';

describe('MaskedIdentifier (23 §8.3, I-CRD-2 — no secret bytes leak)', () => {
  it('SSH → SHA256: fingerprint, never the key bytes', () => {
    const key = Buffer.from(
      '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\n',
    );
    const m = MaskedIdentifier.forSshPrivateKey(key).toString();
    expect(m).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(m).not.toContain('SECRETKEYMATERIAL');
  });

  it('SSH fingerprint is stable for the same key', () => {
    const key = Buffer.from('some-key-bytes');
    expect(MaskedIdentifier.forSshPrivateKey(key).toString()).toBe(
      MaskedIdentifier.forSshPrivateKey(Buffer.from('some-key-bytes')).toString(),
    );
  });

  it('token → tail only, never the body', () => {
    const m = MaskedIdentifier.forToken(Buffer.from('ghp_ABCDEFGHIJKLMNOP')).toString();
    expect(m).toBe('…MNOP');
    expect(m).not.toContain('ABCDEFG');
  });
});
