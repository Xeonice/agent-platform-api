import { inspect, format } from 'node:util';
import { describe, it, expect } from 'vitest';
import { SecretMaterial } from '../../src/domain/value-objects/secret-material.vo';

/**
 * 25 §3.4: the plaintext must NEVER appear in a serialization / inspect / log.
 * These are the four leak paths the D-ruling hardens (23 §8.3).
 */
describe('SecretMaterial redaction (23 §8.3, I-CRD-2)', () => {
  const PLAIN = 'super-secret-token-ghp_ABCDEFG';

  it('toString / String() → [REDACTED]', () => {
    const s = SecretMaterial.fromUtf8(PLAIN);
    expect(s.toString()).toBe('[REDACTED]');
    expect(String(s)).toBe('[REDACTED]');
    expect(`${s}`).toBe('[REDACTED]');
  });

  it('JSON.stringify → "[REDACTED]", never the plaintext', () => {
    const s = SecretMaterial.fromUtf8(PLAIN);
    expect(JSON.stringify(s)).toBe('"[REDACTED]"');
    expect(JSON.stringify({ secret: s })).not.toContain('super-secret');
    expect(JSON.stringify({ secret: s })).toContain('[REDACTED]');
  });

  it('util.inspect / console.log(%o) → [REDACTED] (the most common leak)', () => {
    const s = SecretMaterial.fromUtf8(PLAIN);
    expect(inspect(s)).toBe('[REDACTED]');
    expect(format('%o', s)).toBe('[REDACTED]');
    expect(format('%s', s)).toBe('[REDACTED]');
    expect(inspect({ nested: s })).not.toContain('super-secret');
  });

  it('use() lends the raw Buffer for a bounded scope', () => {
    const s = SecretMaterial.fromUtf8(PLAIN);
    expect(s.use((b) => b.toString('utf8'))).toBe(PLAIN);
    expect(s.use((b) => Buffer.isBuffer(b))).toBe(true);
  });

  it('zeroize() overwrites the plaintext in place', () => {
    const s = SecretMaterial.fromUtf8(PLAIN);
    s.zeroize();
    expect(s.use((b) => b.every((x) => x === 0))).toBe(true);
  });
});
