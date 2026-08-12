import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { env } from '../config/env';

/**
 * Access passcode Guard — SKELETON (shared/11 §3.1, promoted from v1.1 to MVP, audit P0-3).
 *
 * "Does this instance let you in" — no user system, no roles. Not wired as the
 * active APP_GUARD yet (NoopAuthGuard is), but present from commit one so the
 * seam is real. Implemented rules:
 *   - exemptions: GET /api/health and static assets only; /openapi.json is NOT exempt
 *   - 5 consecutive failures per client IP → lock 5 min → 429 + retryAfterSec
 * Not yet implemented (documented TODOs): argon2 hash storage in system_settings,
 * signed 7-day cookie issuance, WS handshake check, Bearer passcode for MCP HTTP.
 */
@Injectable()
export class PasscodeGuard implements CanActivate {
  private static readonly MAX_FAILURES = 5;
  private static readonly LOCK_MS = 5 * 60 * 1000;
  /** per-IP failure state kept in process memory (single-process, 11 §3.1). */
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();

  canActivate(context: ExecutionContext): boolean {
    // passcode disabled → behave like NoopAuthGuard
    if (!env.accessPasscode) {
      return true;
    }
    const req = context.switchToHttp().getRequest<Request>();
    if (this.isExempt(req)) {
      return true;
    }

    const ip = req.ip ?? 'unknown';
    const state = this.failures.get(ip);
    const now = Date.now();
    if (state && state.lockedUntil > now) {
      throw new HttpException(
        { code: 'PASSCODE_LOCKED', retryAfterSec: Math.ceil((state.lockedUntil - now) / 1000) },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (this.presentedPasscode(req) === env.accessPasscode) {
      this.failures.delete(ip);
      return true;
    }

    const nextCount = (state?.count ?? 0) + 1;
    this.failures.set(ip, {
      count: nextCount,
      lockedUntil: nextCount >= PasscodeGuard.MAX_FAILURES ? now + PasscodeGuard.LOCK_MS : 0,
    });
    throw new HttpException({ code: 'PASSCODE_REQUIRED' }, HttpStatus.UNAUTHORIZED);
  }

  private isExempt(req: Request): boolean {
    return req.method === 'GET' && req.path === '/api/health';
  }

  private presentedPasscode(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      return auth.slice('Bearer '.length);
    }
    const header = req.headers['x-access-passcode'];
    return Array.isArray(header) ? header[0] : header;
  }
}
