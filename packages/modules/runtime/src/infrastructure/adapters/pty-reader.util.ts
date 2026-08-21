import type { ProcessStream } from '@platform/contracts';

/**
 * Accumulate a `ProcessStream`'s output until `tryParse` yields a non-null value,
 * the stream exits, or `timeoutMs` elapses. Chunks are concatenated as Buffers and
 * decoded ONCE per read so control bytes (OSC-8, fold newlines) survive intact for
 * the per-CLI parsers. On timeout/exit without a parse it rejects — the endpoint
 * maps that to AUTH_CHALLENGE_EXPIRED / AUTH_REJECTED.
 *
 * 明文纪律 (P1-4a, 05 §4 / 23 §8.3): the accumulated chunks hold the RAW auth bytes —
 * for claude that is the plaintext `sk-ant-oat01-…` setup-token. Once the read settles
 * we `fill(0)` every chunk so the token does not linger in heap buffers awaiting GC.
 * The parsed value is already copied out (`toString`), so zeroing is safe.
 */
export function readUntil<T>(
  pty: ProcessStream,
  tryParse: (accumulated: string) => T | null,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => finish(null, new Error('timeout')), timeoutMs);

    const finish = (value: T | null, err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // wipe the raw plaintext auth bytes before resolving (P1-4a).
      for (const c of chunks) c.fill(0);
      chunks.length = 0;
      if (value !== null) resolve(value);
      else reject(err ?? new Error('stream ended before a match'));
    };

    const attempt = (): void => {
      const text = Buffer.concat(chunks).toString('utf8');
      const value = tryParse(text);
      if (value !== null) finish(value);
    };

    pty.onData((chunk) => {
      if (settled) return; // do not retain bytes after the read has settled + wiped
      chunks.push(chunk);
      attempt();
    });
    pty.onExit(() => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8');
      finish(tryParse(text));
    });
  });
}
