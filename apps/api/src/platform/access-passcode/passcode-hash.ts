import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * One-way hashing for the stored access passcode (shared/11 §3.1 「存储：只存 hash」).
 *
 * ── Why scrypt and not Argon2id ──────────────────────────────────────────────────
 * 11 §3.1 writes 「Argon2id，退化到 bcrypt 亦可」. Both are native addons, i.e. a new
 * compiled dependency in a repo that today builds with zero of them. scrypt is the
 * SAME class of function (memory-hard, deliberately slow) and ships INSIDE Node —
 * `crypto.scryptSync` has been stable since v10. The deviation is recorded here and in
 * 11 §3.1 rather than left for someone to discover in a lockfile.
 *
 * ⚠️ AND THE THREAT MODEL SAYS THE KDF IS NOT WHAT IS DEFENDING THIS SECRET. A memory-
 * hard KDF exists to make GUESSING a low-entropy secret expensive. The passcode this
 * hashes is 16 characters drawn uniformly from a 56-symbol alphabet — about 93 bits.
 * No KDF choice moves an offline attack on that from "infeasible" to "more infeasible".
 * What the hash really buys is that a leaked `platform.db` does not hand over a
 * plaintext credential, and any of the three does that.
 *
 * ── Why the parameters travel INSIDE the stored string ───────────────────────────
 * `scrypt$N$r$p$<salt>$<dk>` is self-describing, so raising the cost later does not
 * invalidate every hash written before the change — an old row still carries the
 * parameters it was written with and still verifies. Hard-coding the cost at the
 * verify site is how a parameter bump turns into "everyone is locked out".
 */

/** 2^15 — ~90ms on the reference machine; a passcode check is not on a hot path. */
const N = 32_768;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

export function hashPasscode(plain: string): string {
  const salt = randomBytes(SALT_LEN);
  const dk = scryptSync(plain, salt, KEY_LEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, R, P, salt.toString('base64'), dk.toString('base64')].join('$');
}

/**
 * Verify a presented passcode against a stored hash.
 *
 * ⚠️ EVERY FAILURE PATH RETURNS `false`, INCLUDING A MALFORMED STORED VALUE. A hash
 * this function cannot parse means the row is corrupt or was written by something
 * else; throwing would turn that into a 500 on the FIRST DOOR of the platform, where
 * the only actionable answer is 「口令不对」 and the operator's route out is to re-run
 * `PUT /api/system/access-passcode`. Never returns `true` on a parse failure — that
 * would make a corrupt column an open door.
 */
export function verifyPasscode(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, dkB64] = parts;
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isFinite(cost.N) || !Number.isFinite(cost.r) || !Number.isFinite(cost.p)) {
    return false;
  }
  const expected = Buffer.from(dkB64, 'base64');
  if (expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(plain, Buffer.from(saltB64, 'base64'), expected.length, {
      ...cost,
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  // lengths are equal by construction above, but `timingSafeEqual` throws on a
  // mismatch rather than returning false, so the guard stays.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
