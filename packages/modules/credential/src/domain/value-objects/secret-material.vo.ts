/**
 * SecretMaterial — the plaintext wrapper (docs/backend/23 §8.3, D-ruling). Plain
 * `string` with `toString/toJSON→[REDACTED]` is "security theatre": one
 * `console.log` bypasses it. This is hardened along FOUR axes:
 *
 *  1. plaintext is carried as a **Buffer** (AES-GCM `decipher` already returns a
 *     Buffer — it is NEVER `.toString()`-ed into a JS string); `zeroize()` fills
 *     it with zeros.
 *  2. plaintext lives in a `#private` field AND
 *     `[Symbol.for('nodejs.util.inspect.custom')]()` returns `'[REDACTED]'` — this
 *     plugs `console.log(secret)` / `%o` (the util.inspect path, the single most
 *     common leak).
 *  3. `use<T>(fn)` lends the Buffer out for a bounded scope; there is NO bare
 *     getter; `toString/toJSON` still return `'[REDACTED]'`.
 *  4. writing the plaintext into a log/Error/outer variable from inside `use`
 *     CANNOT be stopped by the type system — that is held by lint + review. This
 *     is a CONVENTION, not a hard guarantee (documented as such).
 *
 * `zeroize()` is called in a `try/finally` by every consumer.
 *
 * BOUNDARY: this VO must never be imported outside the `credential` context — the
 * plaintext never crosses the aggregate/context edge (I-CRD-2).
 */
const REDACTED = '[REDACTED]';

export class SecretMaterial {
  readonly #plain: Buffer;

  private constructor(plain: Buffer) {
    this.#plain = plain;
  }

  /** Wrap an already-decrypted Buffer. Callers pass the Buffer straight from the
   *  cipher — never a string. */
  static fromBuffer(plain: Buffer): SecretMaterial {
    return new SecretMaterial(plain);
  }

  /** Wrap inbound UTF-8 text (the one place text→Buffer happens, at the store edge). */
  static fromUtf8(plain: string): SecretMaterial {
    return new SecretMaterial(Buffer.from(plain, 'utf8'));
  }

  /**
   * Lend the plaintext Buffer for a bounded computation and return its result.
   * The Buffer must not escape the callback (lint/review-enforced, axis ④).
   */
  use<T>(fn: (plain: Buffer) => T): T {
    return fn(this.#plain);
  }

  /** Overwrite the plaintext in place (call in a `try/finally`). */
  zeroize(): void {
    this.#plain.fill(0);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}
