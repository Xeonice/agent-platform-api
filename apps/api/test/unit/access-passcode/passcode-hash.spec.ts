import { describe, expect, it } from 'vitest';
import { hashPasscode, verifyPasscode } from '../../../src/platform/access-passcode/passcode-hash';

/**
 * The one-way half of 11 §3.1 「存储：只存 hash」. Sealed and dependency-free, so it is
 * a unit test rather than something only reachable through an HTTP round trip.
 */
describe('passcode hashing', () => {
  it('verifies the passcode it was built from, and nothing else', () => {
    const stored = hashPasscode('S1TestPasscode99');
    expect(verifyPasscode('S1TestPasscode99', stored)).toBe(true);
    expect(verifyPasscode('S1TestPasscode98', stored)).toBe(false);
    expect(verifyPasscode('', stored)).toBe(false);
    // a prefix must not pass — it would turn a 16-char secret into a 1-char one.
    expect(verifyPasscode('S', stored)).toBe(false);
  });

  it('is salted: the same passcode hashed twice yields different strings', () => {
    const a = hashPasscode('S1TestPasscode99');
    const b = hashPasscode('S1TestPasscode99');
    // ⚠️ Without a per-hash salt, two instances that happen to share a passcode would
    // have identical columns — and a stolen `platform.db` would answer 「是不是同一个
    // 口令」 for free.
    expect(a).not.toEqual(b);
    expect(verifyPasscode('S1TestPasscode99', a)).toBe(true);
    expect(verifyPasscode('S1TestPasscode99', b)).toBe(true);
  });

  it('never stores the plaintext anywhere inside the hash string', () => {
    const stored = hashPasscode('S1TestPasscode99');
    expect(stored).not.toContain('S1TestPasscode99');
  });

  it('carries its own cost parameters, so raising the cost cannot lock anyone out', () => {
    const stored = hashPasscode('S1TestPasscode99');
    const [scheme, n, r, p] = stored.split('$');
    expect(scheme).toBe('scrypt');
    // the verifier reads N/r/p from the STRING; a row written under old parameters
    // still verifies after the constants here are bumped.
    expect(Number(n)).toBeGreaterThan(1);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);
    const rewritten = ['scrypt', n, r, p, ...stored.split('$').slice(4)].join('$');
    expect(verifyPasscode('S1TestPasscode99', rewritten)).toBe(true);
  });

  it('returns false — never true, never throws — for a stored value it cannot parse', () => {
    // ⚠️ A corrupt column must be a CLOSED door, not an open one and not a 500 on the
    // platform's first screen. All three properties are asserted because two of them
    // are the ways this goes wrong.
    for (const junk of [
      '',
      'not-a-hash',
      'scrypt$x$8$1$aaaa$bbbb',
      'scrypt$16384$8$1$aaaa',
      '$$$$$',
    ]) {
      expect(verifyPasscode('S1TestPasscode99', junk)).toBe(false);
    }
  });
});
