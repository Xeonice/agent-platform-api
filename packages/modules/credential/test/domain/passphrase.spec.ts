import { describe, it, expect } from 'vitest';
import { classifySshPrivateKey } from '../../src/domain/services/passphrase.detector';

const b = (s: string): Buffer => Buffer.from(s, 'utf8');

/** Build a minimal OpenSSH new-format private key body with a chosen ciphername. */
function opensshKey(ciphername: string): Buffer {
  const magic = Buffer.from('openssh-key-v1\0', 'latin1');
  const name = Buffer.from(ciphername, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(name.length, 0);
  const body = Buffer.concat([magic, len, name, Buffer.from('trailingblobdata')]).toString(
    'base64',
  );
  return b(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`);
}

describe('classifySshPrivateKey (03 §7.3 F, I-CRD-6) — deny by default', () => {
  it('rejects traditional PEM with Proc-Type/DEK-Info', () => {
    const key = b(
      '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABC\n\nbody\n-----END RSA PRIVATE KEY-----\n',
    );
    expect(classifySshPrivateKey(key).unprotected).toBe(false);
  });

  it('rejects PKCS#8 ENCRYPTED PRIVATE KEY', () => {
    const key = b(
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nbody\n-----END ENCRYPTED PRIVATE KEY-----\n',
    );
    expect(classifySshPrivateKey(key).unprotected).toBe(false);
  });

  it('rejects OpenSSH key with ciphername != none', () => {
    expect(classifySshPrivateKey(opensshKey('aes256-ctr')).unprotected).toBe(false);
  });

  it('accepts OpenSSH key with ciphername = none', () => {
    expect(classifySshPrivateKey(opensshKey('none')).unprotected).toBe(true);
  });

  it('accepts an unencrypted traditional PEM', () => {
    const key = b(
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n',
    );
    expect(classifySshPrivateKey(key).unprotected).toBe(true);
  });

  it('rejects an unrecognised / unparsable blob (deny by default)', () => {
    expect(classifySshPrivateKey(b('not a key at all')).unprotected).toBe(false);
    expect(
      classifySshPrivateKey(
        b('-----BEGIN OPENSSH PRIVATE KEY-----\n!!!!\n-----END OPENSSH PRIVATE KEY-----'),
      ).unprotected,
    ).toBe(false);
  });
});
