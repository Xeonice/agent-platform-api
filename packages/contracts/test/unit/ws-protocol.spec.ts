import { describe, it, expect } from 'vitest';
import { WS_SCHEMA_HASH, WS_PROTOCOL_CANONICAL, X_SCHEMA_HASH_HEADER } from '@platform/contracts';
import type { SandboxWsEvent } from '@platform/contracts';

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

  it('carries all SEVEN /events variants, including runtime.install_progress', () => {
    // 10 §7.4 / §7.6: the event union is 7 wide since S5. `runtime.install_progress`
    // is separate from `sandbox.status_changed` on purpose — during a CLI install the
    // sandbox status is CONSTANT at `starting` (753s measured), so folding progress in
    // would emit "state changes" where no state changed.
    const events = [
      'sandbox.created',
      'sandbox.status_changed',
      'sandbox.removed',
      'sandbox.waiting_input',
      'project.clone_progress',
      'runtime-auth.status_changed',
      'runtime.install_progress',
    ];
    for (const e of events) expect(WS_PROTOCOL_CANONICAL).toContain(e);
    expect(WS_PROTOCOL_CANONICAL).toContain(
      'runtime.install_progress{sandboxId,runtime,status,versionDetected?,errorCode?}',
    );
  });

  it('the /terminal frame shapes did NOT change, so the pinned handshake hash stands', () => {
    // WS_SCHEMA_HASH gates the /terminal handshake only; adding an /events variant
    // must not break a frontend that pins the literal (14 §2.5).
    expect(WS_PROTOCOL_CANONICAL).toContain(
      'terminal.client:input{data},resize{cols,rows},ping|' +
        'terminal.server:data{data},exit{code},pong,session{socketSessionKey}',
    );
  });
});

describe('runtime.install_progress frame (10 §3.1)', () => {
  it('is assignable with the four documented fields', () => {
    const frame: SandboxWsEvent = {
      event: 'runtime.install_progress',
      sandboxId: 's1',
      runtime: 'claude-code',
      status: 'installing',
      versionDetected: undefined,
      errorCode: undefined,
    };
    expect(frame.event).toBe('runtime.install_progress');
  });
});
