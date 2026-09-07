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
  /**
   * 在等什么 —— **超时消息里唯一有用的那一半**。
   *
   * ⛔ 此前这里恒为 `new Error('timeout')`，于是用户拿到的是
   *    `POST /api/runtimes/claude-code/auth/begin → 500 INTERNAL  Error: timeout`
   *    —— 等了两分钟，然后一个不说明**在等什么**、也不说明**下一步做什么**的 500。
   *    2026-09-07 实测就是这条（根因是宿主 helper 不是真 PTY，claude CLI 一字不出）。
   */
  what = 'CLI output',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    /** 收到过任何字节吗 —— 「一字未出」与「出了但没解析出想要的」是两种病，下一步不同。 */
    let sawAnyBytes = false;
    const timer = setTimeout(
      () =>
        finish(
          null,
          new Error(
            `等待 ${what} 超时（${String(timeoutMs)}ms）` +
              (sawAnyBytes
                ? '：CLI 有输出但没有出现期望的内容 —— 多半是 CLI 版本变了、输出格式与解析器对不上。'
                : '：CLI **一个字节都没输出** —— 登录 CLI 会检测 TTY，' +
                  '最常见的原因是没有给它伪终端；其次是这台机器够不到对应的授权服务。'),
          ),
        ),
      timeoutMs,
    );

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
      if (chunk.length > 0) sawAnyBytes = true;
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
