import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PasscodeService } from './passcode.service';
import { PasscodeAttemptLimiter } from './passcode-attempt-limiter';
import { SESSION_COOKIE, readCookie, setSessionCookie } from './session-cookie';

/**
 * Access passcode Guard — the FIRST real APP_GUARD (docs/shared/11 §3.1, MVP;
 * replaces NoopAuthGuard). Enforced across REST + MCP-over-HTTP (STDIO MCP is not
 * an HTTP context, so it is naturally exempt). GET /api/health and
 * POST /api/access/unlock are exempt (the latter IS the passcode-submission
 * endpoint); /openapi.json is NOT. Lockout is delegated to the shared
 * PasscodeAttemptLimiter (also used by the unlock endpoint). A valid passcode
 * issues a 7-day signed cookie.
 *
 * This folder is exempt from the time/random eslint ban (port-impl exemption).
 */
@Injectable()
export class PasscodeGuard implements CanActivate {
  constructor(
    private readonly passcodes: PasscodeService,
    private readonly limiter: PasscodeAttemptLimiter,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http' || !this.passcodes.enabled) {
      return true; // non-HTTP (STDIO MCP) or passcode disabled ⇒ allow
    }
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    if (this.isExempt(req)) return true;

    const now = Date.now();
    const ip = req.ip ?? 'unknown';
    const lockedFor = this.limiter.lockedForSec(ip, now);
    if (lockedFor > 0) {
      throw new HttpException(
        { code: 'PASSCODE_LOCKED', retryAfterSec: lockedFor },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // already-authenticated session cookie
    if (this.passcodes.verifySessionToken(readCookie(req, SESSION_COOKIE), now)) {
      return true;
    }

    const presented = this.presentedPasscode(req);
    if (presented !== undefined && this.passcodes.matches(presented)) {
      this.limiter.reset(ip);
      setSessionCookie(res, this.passcodes.issueSessionToken(now));
      return true;
    }

    this.limiter.recordFailure(ip, now);
    throw new HttpException({ code: 'PASSCODE_REQUIRED' }, HttpStatus.UNAUTHORIZED);
  }

  private isExempt(req: Request): boolean {
    if (req.method === 'GET' && req.path === '/api/health') return true;
    // the passcode-submission endpoint must itself be reachable without a passcode.
    if (req.method === 'POST' && req.path === '/api/access/unlock') return true;
    return false;
  }

  private presentedPasscode(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
    const header = req.headers['x-access-passcode'];
    if (header) return Array.isArray(header) ? header[0] : header;
    const q = req.query?.['passcode'];
    return typeof q === 'string' ? q : undefined;
  }
}
