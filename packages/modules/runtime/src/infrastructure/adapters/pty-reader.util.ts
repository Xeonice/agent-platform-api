import { ServiceUnavailableException } from '@nestjs/common';
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
   *
   * ⛔⛔ **2026-09-11：那次修复自己变成了那个 500。** 下面这段中文写得很好，但它被塞进一个
   *    裸 `Error` 里 —— `mapAdapterError` 认不出它（没有 code），原样抛出 ⇒
   *    `ErrorEnvelopeFilter` 的第 ④ 支（非 HttpException 一律不透传内部细节）把它整条换成
   *    「服务内部错误，请稍后重试」。写给用户的话，用户一个字也没看到。
   *    ⇒ 现在抛的是**带 code 的 HttpException**（`PROVIDER_UNAVAILABLE`，503，
   *    27 §「beginAuth 错误」里为「helper 不可用」指定的那个码），走 filter 的第 ① 支原样出线。
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
          unavailable(
            `等待 ${what} 超时（${String(timeoutMs)}ms）` +
              (sawAnyBytes
                ? '：命令有输出，但没有出现期望的内容 —— 多半是这个 CLI 换了版本，输出格式和平台的解析对不上了。'
                : '：命令一个字节都没输出 —— 登录 CLI 会检查有没有终端，' +
                  '最常见的原因是没给它分配伪终端；其次是这台机器连不上对应的登录服务。'),
            sawAnyBytes ? 'CLI_OUTPUT_UNPARSED' : 'CLI_SILENT',
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
      // ⚠️ 退出路径同理：裸 Error 在传输层同样会被换成那句「服务内部错误」。
      else
        reject(
          err ??
            unavailable(
              `${what} 还没出结果，命令就已经退出了。多半是这个 CLI 在这台机器上没能正常启动。`,
              'CLI_EXITED_EARLY',
            ),
        );
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

/**
 * 「等 CLI 没等到」→ 503 `PROVIDER_UNAVAILABLE`（27 §beginAuth 为 helper 不可用指定的码）。
 *
 * ⚠️ **给的是完整信封**（`code` + `message` + `retryable`），不是 `{code, message}`：
 * `ErrorEnvelopeFilter` 的第 ② 支会把「半个信封」重建一遍并**丢掉 `details`**，
 * 只有第 ① 支（完整信封）原样放行。
 *
 * ⛔ `message` 里**不拼码**（`access-audit.ts` 的纪律）：码在 `code` 位，机器可读的细分
 * 原因在 `details`，`message` 只留人话。
 */
function unavailable(message: string, reason: string): Error {
  return new ServiceUnavailableException({
    code: 'PROVIDER_UNAVAILABLE',
    message,
    retryable: true,
    details: [{ code: reason }],
  });
}
