import { describe, it, expect } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { ProcessStream } from '@platform/contracts';
import { readUntil } from '../../src/infrastructure/adapters/pty-reader.util';

/**
 * pty-reader 明文纪律 (P1-4a, 05 §4): the accumulated chunks hold raw auth bytes (for
 * claude the plaintext setup-token) — they MUST be `fill(0)`ed once the read settles so
 * the token does not linger in heap buffers.
 */
class FakePty implements ProcessStream {
  detach(): void {}
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

/**
 * ⛔ **超时提示必须真的到达用户。**
 *
 * 那两段中文写得很好，但此前它们被塞在一个裸 `Error` 里 —— `ErrorEnvelopeFilter` 的第 ④ 支
 * （非 HttpException 一律不透传内部细节）会把整条换成「服务内部错误，请稍后重试」。
 * 注释自己写着这段就是为了修「一个不说明在等什么的 500」，而修复本身变成了那个 500。
 */
describe('readUntil 的失败出线形状（文案要能到用户手上）', () => {
  it('超时 → 带 PROVIDER_UNAVAILABLE 的 HttpException（503），message 里有「在等什么」', async () => {
    const pty = new FakePty();
    const err: unknown = await readUntil(pty, () => null, 5, 'codex 打印设备码').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpException);
    const http = err as HttpException;
    expect(http.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    const body = http.getResponse() as {
      code: string;
      message: string;
      retryable: boolean;
      details?: { code?: string }[];
    };
    // 完整信封 ⇒ filter 第 ① 支原样放行（半个信封会被重建并丢掉 details）。
    expect(body.code).toBe('PROVIDER_UNAVAILABLE');
    expect(body.retryable).toBe(true);
    // 「在等什么」必须在，且**码不许拼进散文**（access-audit 的纪律）。
    expect(body.message).toContain('codex 打印设备码');
    expect(body.message).not.toContain('PROVIDER_UNAVAILABLE');
    expect(body.details?.[0]?.code).toBe('CLI_SILENT');
  });

  it('CLI 有输出但解析不出 → 换一条 details 码，message 说的是另一件事', async () => {
    const pty = new FakePty();
    const p: Promise<unknown> = readUntil(pty, () => null, 20, 'claude 打印授权链接').catch(
      (e: unknown) => e,
    );
    pty.emit(Buffer.from('some unrelated banner'));
    const err = await p;
    const body = (err as HttpException).getResponse() as {
      message: string;
      details?: { code?: string }[];
    };
    expect(body.details?.[0]?.code).toBe('CLI_OUTPUT_UNPARSED');
    expect(body.message).toContain('有输出');
  });

  it('提前退出 → 同样是带码的 HttpException，而不是一个哑巴 500', async () => {
    const pty = new FakePty();
    const p: Promise<unknown> = readUntil(pty, () => null, 1000, 'codex 打印设备码').catch(
      (e: unknown) => e,
    );
    pty.exit();
    const err = await p;
    expect(err).toBeInstanceOf(HttpException);
    const body = (err as HttpException).getResponse() as {
      code: string;
      details?: { code?: string }[];
    };
    expect(body.code).toBe('PROVIDER_UNAVAILABLE');
    expect(body.details?.[0]?.code).toBe('CLI_EXITED_EARLY');
  });
});
