import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import { env } from '../config/env';
import { SYSTEM_SETTINGS_ROW_ID, systemSettings } from '../system/system-settings.sqlite';
import { hashPasscode, verifyPasscode } from './passcode-hash';
import type { Request } from 'express';
import { SESSION_COOKIE, readCookie, presentedAccessPasscode } from './session-cookie';
import {
  authorityRequest,
  createAccessAuthorityClient,
  type AccessAuthorityClient,
  type AuthorityDecision,
  type AuthorityAction,
  type AuthorityStatus,
} from './access-authority-client';

type Db = BetterSQLite3Database;

const COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (11 §3.1)
// base58-ish alphabet without 0 O l 1 (11 §3.1)
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** What the passcode currently IS, and where that answer came from. */
export type PasscodeSource = 'env' | 'stored' | 'none';

/**
 * Access passcode service (docs/shared/11 §3.1, MVP). No user system — just
 * "does this instance let you in". Issues a 7-day HMAC-signed session token (the
 * Guard puts it in an HttpOnly cookie).
 * This folder is exempt from the time/random eslint ban (port-impl exemption).
 *
 * ── TWO SOURCES, AND ENV ALWAYS WINS (the rule the whole file hangs off) ─────────
 * `ACCESS_PASSCODE` is a DEPLOYMENT decision written by whoever runs the instance;
 * `system_settings.access_passcode_hash` is a decision made in the UI. When both
 * exist the env one is in force AND `PUT /api/system/access-passcode` refuses with
 * 409, because the alternatives are both dishonest:
 *   · letting the stored value override ⇒ the platform silently overrules a line the
 *     operator explicitly wrote into their compose file;
 *   · letting the write "succeed" while env stays in force ⇒ the operator clicks
 *     [禁用], is told it worked, and the door is still locked.
 * Saying 「这台实例的口令由部署配置固定」 is the only answer that is true.
 *
 * ── WHY `enabled` IS CACHED ──────────────────────────────────────────────────────
 * The Guard asks on EVERY request. The platform is single-process by construction
 * (11 §3.1 keeps the lockout counter in process memory for the same reason), so a
 * cache invalidated by this class's own writers cannot go stale — there is no second
 * writer. It is a cache, not an optimisation of a correctness property: `reload()`
 * exists so a test (or a future second writer) can force the re-read.
 */
@Injectable()
export class PasscodeService {
  private readonly logger = new Logger('PasscodeService');
  private readonly envPasscode: string;
  /** `null` = no stored passcode; otherwise the scrypt hash. Cached, see class note. */
  private storedHash: string | null = null;
  /** Cached signing secret; `''` until first use (it is generated lazily). */
  private sessionSecret = '';
  readonly authorityEnabled: boolean;
  private readonly authorityClient?: AccessAuthorityClient;
  private readonly verifiedRequests = new WeakMap<Request, AuthorityDecision>();
  private readonly changedSessions = new WeakMap<Request, string>();

  constructor(@Inject(DATABASE) private readonly db: Db) {
    this.envPasscode = env.accessPasscode;
    const origin = process.env.UPGRADE_ACCESS_AUTHORITY_ORIGIN;
    this.authorityEnabled = Boolean(origin);
    if (origin) {
      this.authorityClient = createAccessAuthorityClient({
        origin,
        key:
          process.env.UPGRADE_ACCESS_AUTHORITY_KEY ?? process.env.PLATFORM_CONTROLLER_RPC_KEY ?? '',
        instanceId: process.env.PLATFORM_INSTANCE_ID ?? '',
      });
      return; // The independent authority is the only reader/writer of access policy.
    }
    const fresh = this.row() === undefined;
    this.reload();
    if (fresh && this.envPasscode === '' && process.env.ACCESS_PASSCODE_AUTO_GENERATE !== 'false') {
      const plain = PasscodeService.generatePasscode();
      this.setStoredPasscode(plain, new Date());
      // A dedicated stdout channel: never pass the plaintext through the persisted logger.
      process.stdout.write(
        [
          '\n=== 首次启动访问口令 ===',
          plain,
          '请现在保存：平台只存哈希，之后的页面、接口和日志不再回显。',
          '同一浏览器解锁后 7 天内免输。忘了口令可设 ACCESS_PASSCODE 后重启。',
          '换口令：设置 ACCESS_PASSCODE 后重启，或解锁后 PUT /api/system/access-passcode {"action":"regenerate"}。',
          '同时让已登录浏览器失效：接口加 "invalidateSessions":true；或更改 PASSCODE_COOKIE_SECRET 后重启。',
          'docker 的 json-file 日志驱动会保留 stdout，docker logs 可查本次输出。',
          '========================\n',
        ].join('\n'),
      );
    }
    if (this.enabled) {
      this.logger.log(
        `access passcode ENABLED via ${this.source} ` +
          '(REST/MCP-HTTP require it; health + STDIO exempt)',
      );
    }
  }

  /** Re-read the stored hash from the row. Called on boot and after every write. */
  reload(): void {
    this.assertLegacy();
    this.storedHash = this.row()?.accessPasscodeHash ?? null;
  }

  get enabled(): boolean {
    return this.source !== 'none';
  }

  get source(): PasscodeSource {
    this.assertLegacy();
    if (this.envPasscode.length > 0) return 'env';
    return this.storedHash === null ? 'none' : 'stored';
  }

  get sessionSecretPinned(): boolean {
    this.assertLegacy();
    return (process.env.PASSCODE_COOKIE_SECRET ?? '') !== '';
  }

  allowsLoopback(address: string | undefined): boolean {
    if (process.env.ACCESS_PASSCODE_ALLOW_LOOPBACK !== 'true' || !address) return false;
    const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
    return normalized === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
  }

  /** Read-only authorization check using exactly the instance's existing access policy.
   * The HTTP guard still owns lockout accounting and issuing access cookies. */
  authenticatesRequest(req: Request, now: number): boolean {
    if (this.authorityEnabled) return this.verifiedRequests.get(req)?.authorized === true;
    if (!this.enabled || this.allowsLoopback(req.socket.remoteAddress)) return true;
    if (this.verifySessionToken(readCookie(req, SESSION_COOKIE), now)) return true;
    const presented = presentedAccessPasscode(req);
    return presented !== undefined && this.matches(presented);
  }

  /** When the stored passcode was last written — `undefined` for env / never set. */
  get updatedAt(): Date | undefined {
    if (this.source !== 'stored') return undefined;
    return this.row()?.accessPasscodeUpdatedAt ?? undefined;
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

  /**
   * Does this presented string open the door?
   *
   * ⚠️ Constant-time on the env path, and scrypt on the stored path — neither leaks
   * the secret through timing. A disabled passcode答 `false`: 「没有门」 is decided by
   * the Guard (which short-circuits on `enabled`), never by this method returning true
   * for everything, which would make an accidentally-called `matches` an open door.
   */
  matches(presented: string): boolean {
    if (this.source === 'env') {
      const a = Buffer.from(presented);
      const b = Buffer.from(this.envPasscode);
      return a.length === b.length && timingSafeEqual(a, b);
    }
    if (this.storedHash === null) return false;
    return verifyPasscode(presented, this.storedHash);
  }

  /**
   * Write a new stored passcode (or clear it) and return the plaintext ONCE.
   *
   * ⚠️ THE SESSION SECRET IS NOT TOUCHED HERE, AND THAT IS THE REQUIREMENT
   * (11 §3.1 「已通过的会话不受口令重新生成影响」). It used to be derived from the
   * passcode itself, which would have made every rotation a fleet-wide logout — the
   * kind of behaviour nobody notices until the day they rotate.
   */
  setStoredPasscode(plain: string | null, now: Date, invalidateSessions = false): void {
    this.assertLegacy();
    const secret = invalidateSessions ? randomBytes(32).toString('hex') : undefined;
    this.ensureRow();
    this.db
      .update(systemSettings)
      .set({
        accessPasscodeHash: plain === null ? null : hashPasscode(plain),
        accessPasscodeUpdatedAt: plain === null ? null : now,
        ...(secret !== undefined ? { accessPasscodeSessionSecret: secret } : {}),
      })
      .where(eq(systemSettings.id, SYSTEM_SETTINGS_ROW_ID))
      .run();
    if (secret !== undefined) this.sessionSecret = secret;
    this.reload();
  }

  /** `${String(expiresAt)}.${hmac}` — verified without server-side session state. */
  issueCurrentSessionToken(): string {
    return this.issueSessionToken(Date.now());
  }

  issueSessionToken(now: number): string {
    this.assertLegacy();
    const expiresAt = now + COOKIE_TTL_MS;
    return `${String(expiresAt)}.${this.sign(String(expiresAt))}`;
  }

  verifySessionToken(token: string | undefined, now: number): boolean {
    this.assertLegacy();
    if (!token) return false;
    const dot = token.lastIndexOf('.');
    if (dot < 0) return false;
    const expiresAt = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = this.sign(expiresAt);
    // constant-time: the comparison is against a value an attacker supplies.
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    return Number(expiresAt) > now;
  }

  private assertLegacy(): void {
    if (this.authorityEnabled)
      throw new HttpException(
        {
          code: 'ACCESS_AUTHORITY_REQUIRED',
          message: '访问策略由独立控制服务管理',
          retryable: false,
          sideEffectFree: true,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
  }
  accessStatus(): Promise<AuthorityStatus> {
    if (this.authorityClient) return this.authorityClient.status();
    return Promise.resolve({
      enabled: this.enabled,
      source: this.source,
      envOverride: this.source === 'env',
      sessionSecretPinned: this.sessionSecretPinned,
      revision: 1,
      updatedAt: this.updatedAt?.toISOString() ?? null,
    });
  }
  async isEnabledAsync(): Promise<boolean> {
    return (await this.accessStatus()).enabled;
  }
  async authorizeRequest(req: Request): Promise<AuthorityDecision> {
    if (!this.authorityClient) throw new Error('Independent access authority is not configured');
    const decision = await this.authorityClient.authenticate(authorityRequest(req));
    this.verifiedRequests.set(req, decision);
    return decision;
  }
  authorityDecision(req: Request): AuthorityDecision | undefined {
    return this.verifiedRequests.get(req);
  }
  async authorizeTerminal(credentials: {
    remoteAddress?: string;
    sessionToken?: string;
    passcode?: string;
  }): Promise<boolean> {
    if (!this.authorityClient) throw new Error('Independent access authority is not configured');
    const remoteAddress = credentials.remoteAddress ?? null;
    const value = await this.authorityClient.authenticate(
      {
        remoteAddress,
        clientIp: remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown',
        ...(credentials.sessionToken
          ? { cookie: `ap_session=${encodeURIComponent(credentials.sessionToken)}` }
          : {}),
        ...(credentials.passcode !== undefined ? { passcode: credentials.passcode } : {}),
      },
      'ws',
    );
    return value.authorized;
  }
  async unlockAtAuthority(req: Request, plain: string): Promise<AuthorityDecision> {
    if (!this.authorityClient) throw new Error('Independent access authority is not configured');
    return this.authorityClient.unlock(authorityRequest(req, plain));
  }
  async changeAtAuthority(req: Request, input: AuthorityAction) {
    if (!this.authorityClient) throw new Error('Independent access authority is not configured');
    const change = await this.authorityClient.change(authorityRequest(req), input);
    if (change.sessionToken) this.changedSessions.set(req, change.sessionToken);
    return change;
  }
  issueCurrentSessionTokenAsync(req?: Request): Promise<string> {
    if (!this.authorityEnabled) return Promise.resolve(this.issueCurrentSessionToken());
    const token = req ? this.changedSessions.get(req) : undefined;
    if (!token)
      throw new HttpException(
        {
          code: 'ACCESS_AUTHORITY_REQUIRED',
          message: '无法确认本次会话变更',
          retryable: false,
          sideEffectFree: false,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    if (req) this.changedSessions.delete(req);
    return Promise.resolve(token);
  }
  authorityFingerprint() {
    if (!this.authorityClient) throw new Error('Independent access authority is not configured');
    return this.authorityClient.fingerprint();
  }
  authorityChallenge(legacyBaseline: boolean) {
    if (!this.authorityClient) throw new Error('Independent access authority is not configured');
    return this.authorityClient.challenge(legacyBaseline);
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.signingSecret()).update(payload).digest('hex');
  }

  /**
   * The cookie signing key — env override, else a persisted per-instance random.
   *
   * ⚠️ IT MUST SURVIVE A RESTART, which is why it is a COLUMN and not a module-level
   * random. The cookie promises 7 days; a fresh secret per process would silently cut
   * that to "until the next deploy" — and the symptom (everyone re-entering the
   * passcode after an unrelated restart) reads as a bug in the cookie, not here.
   */
  private signingSecret(): string {
    const fromEnv = process.env.PASSCODE_COOKIE_SECRET ?? '';
    if (fromEnv !== '') return fromEnv;
    if (this.sessionSecret !== '') return this.sessionSecret;
    const stored = this.row()?.accessPasscodeSessionSecret ?? null;
    if (stored !== null && stored !== '') {
      this.sessionSecret = stored;
      return stored;
    }
    const minted = randomBytes(32).toString('hex');
    this.ensureRow();
    this.db
      .update(systemSettings)
      .set({ accessPasscodeSessionSecret: minted })
      .where(eq(systemSettings.id, SYSTEM_SETTINGS_ROW_ID))
      .run();
    this.sessionSecret = minted;
    return minted;
  }

  private row(): typeof systemSettings.$inferSelect | undefined {
    return this.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.id, SYSTEM_SETTINGS_ROW_ID))
      .all()[0];
  }

  /**
   * The single row is created ON DEMAND rather than seeded by a migration — the same
   * discipline `SystemSettingsService` states: a migration-seeded row is absent from
   * every `:memory:` database and every hand-built one, and its absence surfaces as a
   * 500 on the platform's first screen.
   */
  private ensureRow(): void {
    this.db
      .insert(systemSettings)
      .values({ id: SYSTEM_SETTINGS_ROW_ID, initialized: false })
      .onConflictDoNothing()
      .run();
  }
}
