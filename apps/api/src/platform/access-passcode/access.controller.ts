import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AUDIT_RECORDER } from '@platform/contracts';
import type { AuditRecorder } from '@platform/contracts';
import { PasscodeService } from './passcode.service';
import { PasscodeAttemptLimiter } from './passcode-attempt-limiter';
import { passcodeInvalid, passcodeLocked } from './passcode-errors';
import { setSessionCookie } from './session-cookie';
import {
  accessLockedRecord,
  lockedAttemptRecord,
  unlockFailedRecord,
  unlockSucceededRecord,
} from './access-audit';

const UnlockSchema = z.object({ passcode: z.string().min(1) });
export class UnlockRequestDto extends createZodDto(UnlockSchema) {}

/**
 * Access unlock endpoint (docs/shared/11 §3.1): the frontend posts the passcode
 * here; on success it receives the 7-day signed `ap_session` HttpOnly cookie that
 * the PasscodeGuard (REST/MCP) and the terminal WS authenticator both accept.
 * This route is passcode-EXEMPT in the guard (it IS the submission point) and
 * feeds the SAME shared lockout as the guard (5 failures → 429).
 *
 * This folder is exempt from the time/random eslint ban (port-impl exemption).
 *
 * ── 审计（13 §2.8.2 `category: 'system'`）────────────────────────────────────
 * 这条路径上的四件事全部进审计流，形状收在 `access-audit.ts`。它走的是**写入口 ②**
 * （`AUDIT_RECORDER`）而不是 projector：口令失败**整个就是失败路径**，没有聚合、
 * 没有领域事件，projector 什么也收不到（13 §2.8.2「第 2 个入口不是可选项」）。
 *
 * ⚠️ **`PasscodeGuard` 那一侧刻意不记**，尽管它喂的是同一把锁。它的失败分支在
 * 「任何一个没带 cookie 的受保护请求」上都会走到 —— 用户第一次打开界面、会话过期后
 * 前端的一轮并发拉取，都会各撞一次。把它记进审计等于把「访问日志」灌进产品面板，
 * 正是 P21-5 §10.1 明令不要做的事，而且真正的信号（有人在**提交口令**）会被淹掉。
 * ⇒ 只记「有人在这道门上提交口令」的那条路径，也就是本 controller。
 */
@ApiTags('access')
@Controller('access')
export class AccessController {
  constructor(
    private readonly passcodes: PasscodeService,
    private readonly limiter: PasscodeAttemptLimiter,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  @Post('unlock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit the access passcode; sets the ap_session cookie on success' })
  unlock(
    @Body() body: UnlockRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): { unlocked: true } {
    // no passcode configured (dev) ⇒ nothing to unlock; the guard also allows all.
    // ⚠️ 也不记审计：这里根本没有门，落一行「已解锁」是在记一件没发生的事。
    if (!this.passcodes.enabled) return { unlocked: true };

    const now = Date.now();
    const ip = req.ip ?? 'unknown';
    const lockedFor = this.limiter.lockedForSec(ip, now);
    if (lockedFor > 0) {
      this.audit.record(lockedAttemptRecord(lockedFor));
      throw passcodeLocked(lockedFor);
    }

    if (this.passcodes.matches(body.passcode)) {
      this.limiter.reset(ip);
      setSessionCookie(res, this.passcodes.issueSessionToken(now));
      this.audit.record(unlockSucceededRecord());
      return { unlocked: true };
    }

    const outcome = this.limiter.recordFailure(ip, now);
    this.audit.record(unlockFailedRecord(outcome));
    // 达到阈值的那一次，除了「又错一次」还要落一行**门被锁上了**（error 级）。
    if (outcome.lockedForSec > 0) this.audit.record(accessLockedRecord(outcome));
    throw passcodeInvalid();
  }
}
