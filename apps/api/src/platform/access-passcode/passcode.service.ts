import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';

const COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (11 §3.1)
// base58-ish alphabet without 0 O l 1 (11 §3.1)
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Access passcode service (docs/shared/11 §3.1, MVP). No user system — just
 * "does this instance let you in". Non-empty ACCESS_PASSCODE ⇒ enabled. Issues a
 * 7-day HMAC-signed session token (the Guard puts it in an HttpOnly cookie).
 * This folder is exempt from the time/random eslint ban (port-impl exemption).
 */
@Injectable()
export class PasscodeService {
  private readonly logger = new Logger('PasscodeService');
  readonly enabled: boolean;
  private readonly passcode: string;
  private readonly secret: string;

  constructor() {
    this.passcode = env.accessPasscode;
    this.enabled = this.passcode.length > 0;
    this.secret = process.env.PASSCODE_COOKIE_SECRET ?? this.passcode ?? '';
    if (this.enabled) {
      this.logger.log('access passcode ENABLED (REST/MCP-HTTP require it; health + STDIO exempt)');
    }
  }

  /** 16-char base58 passcode, no ambiguous chars (11 §3.1). */
  static generatePasscode(): string {
    const bytes = randomBytes(16);
    let out = '';
    for (let i = 0; i < 16; i++) {
      out += ALPHABET[bytes[i] % ALPHABET.length];
    }
    return out;
  }

  matches(presented: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(this.passcode);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** `${expiresAt}.${hmac}` — verified without server-side session state. */
  issueSessionToken(now: number): string {
    const expiresAt = now + COOKIE_TTL_MS;
    return `${expiresAt}.${this.sign(String(expiresAt))}`;
  }

  verifySessionToken(token: string | undefined, now: number): boolean {
    if (!token) return false;
    const dot = token.lastIndexOf('.');
    if (dot < 0) return false;
    const expiresAt = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    if (this.sign(expiresAt) !== mac) return false;
    return Number(expiresAt) > now;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }
}
