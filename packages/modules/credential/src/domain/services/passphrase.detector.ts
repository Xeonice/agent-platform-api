/**
 * SSH private-key passphrase detection (docs/backend/03 §7.3 F, 13 §2.5.1,
 * 23 I-CRD-6). Passphrase-protected keys are REJECTED at store time — an
 * unattended container has nowhere to type a passphrase, and ssh-agent would keep
 * the decrypted key resident across requests. MVP does not support them.
 *
 * The rule is DENY-BY-DEFAULT: a key is accepted only when we can positively
 * confirm it carries no passphrase. Detected encrypted forms:
 *   - traditional PEM: `Proc-Type: 4,ENCRYPTED` / `DEK-Info:`
 *   - PKCS#8 encrypted: `-----BEGIN ENCRYPTED PRIVATE KEY-----`
 *   - OpenSSH new format: parsed `ciphername ≠ none`
 * Anything we cannot parse into a "definitely unencrypted" shape is rejected too.
 *
 * Pure function (no IO) — a domain invariant, unit-testable directly.
 */
export interface PassphraseVerdict {
  /** true = confirmed to carry NO passphrase (safe to store). */
  unprotected: boolean;
  reason: string;
}

const OPENSSH_BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
const OPENSSH_END = '-----END OPENSSH PRIVATE KEY-----';
const OPENSSH_MAGIC = 'openssh-key-v1\0';

/** Extract the OpenSSH new-format `ciphername`, or null if it cannot be parsed. */
function opensshCiphername(pem: string): string | null {
  const begin = pem.indexOf(OPENSSH_BEGIN);
  const end = pem.indexOf(OPENSSH_END);
  if (begin < 0 || end < 0 || end <= begin) return null;
  const b64 = pem.slice(begin + OPENSSH_BEGIN.length, end).replace(/\s+/g, '');
  if (b64.length === 0) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < OPENSSH_MAGIC.length) return null;
  if (buf.toString('latin1', 0, OPENSSH_MAGIC.length) !== OPENSSH_MAGIC) return null;
  let off = OPENSSH_MAGIC.length;
  if (off + 4 > buf.length) return null;
  const len = buf.readUInt32BE(off);
  off += 4;
  if (len <= 0 || off + len > buf.length) return null;
  return buf.toString('utf8', off, off + len);
}

export function classifySshPrivateKey(key: Buffer): PassphraseVerdict {
  const text = key.toString('utf8');

  if (/Proc-Type:\s*4,\s*ENCRYPTED/i.test(text) || /DEK-Info:/i.test(text)) {
    return { unprotected: false, reason: 'traditional PEM is passphrase-encrypted (Proc-Type/DEK-Info)' };
  }
  if (text.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----')) {
    return { unprotected: false, reason: 'PKCS#8 encrypted private key' };
  }
  if (text.includes(OPENSSH_BEGIN)) {
    const cipher = opensshCiphername(text);
    if (cipher === null) {
      return { unprotected: false, reason: 'unparsable OpenSSH private key (cannot confirm no passphrase)' };
    }
    if (cipher !== 'none') {
      return { unprotected: false, reason: `OpenSSH key encrypted with cipher '${cipher}'` };
    }
    return { unprotected: true, reason: 'OpenSSH key, ciphername=none' };
  }
  // Unencrypted traditional/PKCS#8/SEC1 PEM bodies (encrypted variants were caught above).
  if (
    /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/.test(text) &&
    /-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/.test(text)
  ) {
    return { unprotected: true, reason: 'unencrypted PEM private key' };
  }
  return { unprotected: false, reason: 'unrecognised private-key format (deny by default)' };
}
