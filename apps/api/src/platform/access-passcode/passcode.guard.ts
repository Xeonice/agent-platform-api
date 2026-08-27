import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PasscodeService } from './passcode.service';
import { PasscodeAttemptLimiter } from './passcode-attempt-limiter';
import { passcodeLocked, passcodeRequired } from './passcode-errors';
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

    /**
     * ⚠️ **已认证的会话先放行，锁定检查排在它后面 —— 顺序是承重的。**
     *
     * 此前反过来：锁定先判。后果是**任何人从同一 IP 猜错 5 次口令，就能把所有已登录
     * 会话一起锁死 5 分钟** —— 家用 NAT、公司出口、docker bridge 后面全是同一个 `req.ip`。
     * 实测表现：用户早已解锁、cookie 完全有效，界面却在建任务时弹
     * 「口令错误次数过多，已暂时锁定；请 277 秒后重试」，而他这一轮**一次口令都没输过**。
     *
     * 锁定的目的是**拦住正在猜口令的请求**（11 §3.1 的暴力破解防护）。一个带着有效签名
     * cookie 的请求不是在猜口令 —— 拿限流去拦它，防不到攻击者，只是把合法用户踢下线：
     * 攻击者反而得到一个**零成本的 DoS**（猜 5 次错口令 = 全员掉线 5 分钟）。
     *
     * ⚠️ `POST /api/access/unlock` 不走这里（`isExempt`），它在 controller 里自己查锁定
     * ——那条路径**确实**在提交口令，该受锁定约束。两处的差别正是「有没有在猜口令」。
     */
    if (this.passcodes.verifySessionToken(readCookie(req, SESSION_COOKIE), now)) {
      return true;
    }

    const lockedFor = this.limiter.lockedForSec(ip, now);
    if (lockedFor > 0) {
      throw passcodeLocked(lockedFor);
    }

    const presented = this.presentedPasscode(req);
    if (presented !== undefined && this.passcodes.matches(presented)) {
      this.limiter.reset(ip);
      setSessionCookie(res, this.passcodes.issueSessionToken(now));
      return true;
    }

    this.limiter.recordFailure(ip, now);
    throw passcodeRequired();
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
