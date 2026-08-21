import { describe, it, expect } from 'vitest';
import type { ProcessStream } from '@platform/contracts';
import { readUntil } from '../../src/infrastructure/adapters/pty-reader.util';

/**
 * pty-reader 明文纪律 (P1-4a, 05 §4): the accumulated chunks hold raw auth bytes (for
 * claude the plaintext setup-token) — they MUST be `fill(0)`ed once the read settles so
 * the token does not linger in heap buffers.
 */
class FakePty implements ProcessStream {
  readonly ref = 'fake';
  private dataCb?: (c: Buffer) => void;
  private exitCb?: (code: number | null) => void;
  onData(cb: (c: Buffer) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (code: number | null) => void): void {
    this.exitCb = cb;
  }
  write(): void {}
  resize(): void {}
  async kill(): Promise<void> {}
  emit(chunk: Buffer): void {
    this.dataCb?.(chunk);
  }
  exit(): void {
    this.exitCb?.(null);
  }
}

describe('readUntil (pty-reader) plaintext discipline', () => {
  it('zeroes the accumulated buffers after a successful parse', async () => {
    const pty = new FakePty();
    const secret = Buffer.from('sk-ant-oat01-SECRETTOKENBYTES');
    const p = readUntil(pty, (s) => (s.includes('SECRETTOKEN') ? s : null), 1000);
    pty.emit(secret);
    const parsed = await p;
    // the parsed value is a copied-out string (still intact) …
    expect(parsed).toContain('sk-ant-oat01-');
    // … but the source buffer has been wiped.
    expect(secret.every((b) => b === 0)).toBe(true);
  });

  it('zeroes buffers on the exit-without-match rejection path too', async () => {
    const pty = new FakePty();
    const chunk = Buffer.from('partial-secret-bytes');
    const p = readUntil(pty, () => null, 1000).catch((e: Error) => e);
    pty.emit(chunk);
    pty.exit();
    await p;
    expect(chunk.every((b) => b === 0)).toBe(true);
  });
});
