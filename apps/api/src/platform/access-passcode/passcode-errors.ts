import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 口令门的三个拒绝信封（10 §6.8 的 `PASSCODE_*` 三行）。
 *
 * ── 为什么收在一个文件里 ─────────────────────────────────────────────────────
 * `PASSCODE_LOCKED` 由 `PasscodeGuard`（拦所有受保护请求）和 `AccessController`
 * （解锁端点自己）**各抛一次**，用的是同一把锁。两处分开写，形状迟早漂移——
 * 与 `session-cookie.ts` 把 cookie 名/属性收在一处是同一个理由。
 *
 * ── 为什么每一条都必须自带 message ───────────────────────────────────────────
 * ⚠️ 这四处曾经抛的是 `{ code: 'PASSCODE_LOCKED', retryAfterSec }`——**有 code、没有
 * message**。而 `ErrorEnvelopeFilter` 当时只认「完整信封」和「code+message」两种形状，
 * 于是这个 body 两边都不匹配，被当成裸 Nest 异常处理：`code` 打回 `codeForStatus(429)`
 * 的 `BAD_REQUEST`，`message` 退回 Nest 默认的 `'Http Exception'`。
 * 用户在解锁页上看到的就是那四个字——**平台的第一道门，给出的唯一提示是一句机器话**。
 * filter 那边已经补上「有 code 就保住 code」（见 ②'），但那只救得回名字，救不回人话：
 * 说得清「到底哪儿不对」的那句，只有抛出点知道。
 *
 * ── `sideEffectFree` 为什么这里给得起 ───────────────────────────────────────
 * 传输层刻意不猜这一位（04 §5：它由**位置**挣得）。而这三条都是**门口拒绝**：
 * 请求连业务逻辑都没进去，平台没动过任何状态。10 §6.8 的三行也都标着 ✅。
 */

/** 未解锁（`PasscodeGuard` 拦下受保护请求）。401，不可重试——要变的是先去解锁。 */
export function passcodeRequired(): HttpException {
  return new HttpException(
    {
      code: 'PASSCODE_REQUIRED',
      message: '此环境已启用访问口令，请先解锁后再访问',
      retryable: false,
      sideEffectFree: true,
    },
    HttpStatus.UNAUTHORIZED,
  );
}

/** 口令错误。401，不可重试——原样重发必然同样被拒，要变的是口令本身。 */
export function passcodeInvalid(): HttpException {
  return new HttpException(
    {
      code: 'PASSCODE_INVALID',
      message: '访问口令不正确',
      retryable: false,
      sideEffectFree: true,
    },
    HttpStatus.UNAUTHORIZED,
  );
}

/**
 * 连续失败被锁。429，**可重试**——它说的正是「稍后再来」，所以 `retryAfterSec`
 * 必须随行：没有它，「可重试」就退化成让用户盲目重试，而每次重试都只是再撞一次锁。
 */
export function passcodeLocked(retryAfterSec: number): HttpException {
  return new HttpException(
    {
      code: 'PASSCODE_LOCKED',
      message: `口令错误次数过多，已暂时锁定；请 ${String(retryAfterSec)} 秒后重试`,
      retryable: true,
      sideEffectFree: true,
      retryAfterSec,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
