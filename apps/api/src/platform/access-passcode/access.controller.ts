import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PasscodeService } from './passcode.service';
import { PasscodeAttemptLimiter } from './passcode-attempt-limiter';
import { setSessionCookie } from './session-cookie';

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
 */
@ApiTags('access')
@Controller('access')
export class AccessController {
  constructor(
    private readonly passcodes: PasscodeService,
    private readonly limiter: PasscodeAttemptLimiter,
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
    if (!this.passcodes.enabled) return { unlocked: true };

    const now = Date.now();
    const ip = req.ip ?? 'unknown';
    const lockedFor = this.limiter.lockedForSec(ip, now);
    if (lockedFor > 0) {
      throw new HttpException(
        { code: 'PASSCODE_LOCKED', retryAfterSec: lockedFor },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (this.passcodes.matches(body.passcode)) {
      this.limiter.reset(ip);
      setSessionCookie(res, this.passcodes.issueSessionToken(now));
      return { unlocked: true };
    }

    this.limiter.recordFailure(ip, now);
    throw new HttpException({ code: 'PASSCODE_INVALID' }, HttpStatus.UNAUTHORIZED);
  }
}
