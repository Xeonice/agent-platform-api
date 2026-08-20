import type { ProcessStream } from '@platform/contracts';

/**
 * Accumulate a `ProcessStream`'s output until `tryParse` yields a non-null value,
 * the stream exits, or `timeoutMs` elapses. Chunks are concatenated as Buffers and
 * decoded ONCE per read so control bytes (OSC-8, fold newlines) survive intact for
 * the per-CLI parsers. On timeout/exit without a parse it rejects — the endpoint
 * maps that to AUTH_CHALLENGE_EXPIRED / AUTH_REJECTED.
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
      if (value !== null) resolve(value);
      else reject(err ?? new Error('stream ended before a match'));
    };

    const attempt = (): void => {
      const text = Buffer.concat(chunks).toString('utf8');
      const value = tryParse(text);
      if (value !== null) finish(value);
    };

    pty.onData((chunk) => {
      chunks.push(chunk);
      attempt();
    });
    pty.onExit(() => {
      const text = Buffer.concat(chunks).toString('utf8');
      finish(tryParse(text));
    });
  });
}
