import { createHash } from 'node:crypto';

/**
 * MaskedIdentifier (docs/backend/23 §8.3). Masking is done ONCE, here, at
 * construction — never re-implemented per DTO. For SSH the masked form is a
 * `SHA256:` fingerprint; for an HTTPS token it is a tail (I-CRD-2 — the private
 * key / token are NEVER stored or returned in the clear).
 *
 * NOTE (bounded simplification): the SSH fingerprint is a stable SHA256 over the
 * (whitespace-normalised) private-key material, formatted like an OpenSSH
 * fingerprint. It is a non-reversible, stable identifier suitable for display and
 * de-dup; it is NOT guaranteed byte-identical to the canonical OpenSSH public-key
 * wire fingerprint (deriving that from an arbitrary private-key encoding is out of
 * MVP scope). Either way no key bytes are recoverable from it.
 */
export class MaskedIdentifier {
  private constructor(readonly value: string) {}

  static rehydrate(value: string): MaskedIdentifier {
    return new MaskedIdentifier(value);
  }

  /** `SHA256:<base64-nopad>` fingerprint of the private key (no key bytes leak). */
  static forSshPrivateKey(plain: Buffer): MaskedIdentifier {
    const normalized = Buffer.from(plain.toString('utf8').replace(/\s+/g, ''), 'utf8');
    const digest = createHash('sha256').update(normalized).digest('base64').replace(/=+$/, '');
    return new MaskedIdentifier(`SHA256:${digest}`);
  }

  /** Token tail (e.g. `…WXYZ`); the body is never shown. */
  static forToken(plain: Buffer): MaskedIdentifier {
    const text = plain.toString('utf8').trim();
    const tail = text.length <= 4 ? text : text.slice(-4);
    return new MaskedIdentifier(`…${tail}`);
  }

  toString(): string {
    return this.value;
  }
}
