import { describe, it, expect } from 'vitest';
import { WS_SCHEMA_HASH, WS_PROTOCOL_CANONICAL, X_SCHEMA_HASH_HEADER } from '@platform/contracts';

/**
 * WS protocol handshake constant (docs/shared/14 §2.5). S1 pins WS_SCHEMA_HASH to
 * a shared literal that must byte-equal the frontend's hardcoded value so the
 * /terminal handshake actually agrees; the real codegen-hash toolchain is later.
 */
describe('WS protocol schema hash', () => {
  it('is the pinned cross-repo literal (must equal the frontend constant)', () => {
    expect(WS_SCHEMA_HASH).toBe('sb-terminal-v1');
    expect(X_SCHEMA_HASH_HEADER).toBe('x-schema-hash');
  });

  it('documents the canonical frame shapes it stands for', () => {
    expect(WS_PROTOCOL_CANONICAL).toContain('terminal.server:data{data}');
    expect(WS_PROTOCOL_CANONICAL).toContain('session{socketSessionKey}');
  });
});
