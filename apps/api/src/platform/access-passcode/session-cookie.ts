import type { Request, Response } from 'express';

/**
 * Shared `ap_session` cookie handling (docs/shared/11 §3.1) — used by BOTH the
 * `PasscodeGuard` (verifies it) and the `POST /api/access/unlock` endpoint (issues
 * it), so the name/attributes stay in lockstep. 7-day HttpOnly, SameSite=Lax,
 * Path=/; Secure when PASSCODE_COOKIE_SECURE=true (behind TLS/reverse proxy).
 */
export const SESSION_COOKIE = 'ap_session';
export const COOKIE_MAX_AGE_SEC = 7 * 24 * 60 * 60;

export function setSessionCookie(res: Response, value: string): void {
  const secure = process.env.PASSCODE_COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${String(COOKIE_MAX_AGE_SEC)}${secure}`,
  );
}

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** The existing instance access credential transports, shared by the guard and upgrades. */
export function presentedAccessPasscode(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  const header = req.headers['x-access-passcode'];
  if (header) return Array.isArray(header) ? header[0] : header;
  const query = req.query.passcode;
  return typeof query === 'string' ? query : undefined;
}
