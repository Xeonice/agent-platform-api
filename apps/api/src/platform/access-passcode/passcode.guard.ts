import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PasscodeService } from './passcode.service';

const SESSION_COOKIE = 'ap_session';
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000; // 5 minutes
const COOKIE_MAX_AGE_SEC = 7 * 24 * 60 * 60;

/**
 * Access passcode Guard — the FIRST real APP_GUARD (docs/shared/11 §3.1, MVP;
 * replaces NoopAuthGuard). Enforced across REST + MCP-over-HTTP (STDIO MCP is not
 * an HTTP context, so it is naturally exempt). GET /api/health is exempt;
 * /openapi.json is NOT (it exposes the full surface). 5 consecutive failures per
 * client IP → lock 5 minutes (429). A valid passcode issues a 7-day signed cookie.
 *
 * This folder is exempt from the time/random eslint ban (port-impl exemption).
 */
@Injectable()
export class PasscodeGuard implements CanActivate {
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(private readonly passcodes: PasscodeService) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http' || !this.passcodes.enabled) {
      return true; // non-HTTP (STDIO MCP) or passcode disabled ⇒ allow
    }
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    if (this.isExempt(req)) return true;

    const now = Date.now();
    const ip = req.ip ?? 'unknown';
    const state = this.failures.get(ip);
    if (state && state.lockedUntil > now) {
      throw new HttpException(
        { code: 'PASSCODE_LOCKED', retryAfterSec: Math.ceil((state.lockedUntil - now) / 1000) },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // already-authenticated session cookie
    if (this.passcodes.verifySessionToken(this.cookie(req, SESSION_COOKIE), now)) {
      return true;
    }

    const presented = this.presentedPasscode(req);
    if (presented !== undefined && this.passcodes.matches(presented)) {
      this.failures.delete(ip);
      this.setSessionCookie(res, this.passcodes.issueSessionToken(now));
      return true;
    }

    const count = (state?.count ?? 0) + 1;
    this.failures.set(ip, {
      count,
      lockedUntil: count >= MAX_FAILURES ? now + LOCK_MS : 0,
    });
    throw new HttpException({ code: 'PASSCODE_REQUIRED' }, HttpStatus.UNAUTHORIZED);
  }

  private isExempt(req: Request): boolean {
    return req.method === 'GET' && req.path === '/api/health';
  }

  private presentedPasscode(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
    const header = req.headers['x-access-passcode'];
    if (header) return Array.isArray(header) ? header[0] : header;
    const q = req.query?.['passcode'];
    return typeof q === 'string' ? q : undefined;
  }

  private cookie(req: Request, name: string): string | undefined {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === name) return decodeURIComponent(rest.join('='));
    }
    return undefined;
  }

  private setSessionCookie(res: Response, value: string): void {
    const secure = process.env.PASSCODE_COOKIE_SECURE === 'true' ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}${secure}`,
    );
  }
}
