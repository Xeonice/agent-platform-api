import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import { env } from '../config/env';
import { SYSTEM_SETTINGS_ROW_ID, systemSettings } from '../system/system-settings.sqlite';
import { hashPasscode, verifyPasscode } from './passcode-hash';

type Db = BetterSQLite3Database<Record<string, never>>;

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

  constructor(@Inject(DATABASE) private readonly db: Db) {
    this.envPasscode = env.accessPasscode;
    this.reload();
    if (this.enabled) {
      this.logger.log(
        `access passcode ENABLED via ${this.source} ` +
          '(REST/MCP-HTTP require it; health + STDIO exempt)',
      );
    }
  }

  /** Re-read the stored hash from the row. Called on boot and after every write. */
  reload(): void {
    this.storedHash = this.row()?.accessPasscodeHash ?? null;
  }

  get enabled(): boolean {
    return this.source !== 'none';
  }

  get source(): PasscodeSource {
    if (this.envPasscode.length > 0) return 'env';
    return this.storedHash === null ? 'none' : 'stored';
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
  setStoredPasscode(plain: string | null, now: Date): void {
    this.ensureRow();
    this.db
      .update(systemSettings)
      .set({
        accessPasscodeHash: plain === null ? null : hashPasscode(plain),
        accessPasscodeUpdatedAt: plain === null ? null : now,
      })
      .where(eq(systemSettings.id, SYSTEM_SETTINGS_ROW_ID))
      .run();
    this.reload();
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
    const expected = this.sign(expiresAt);
    // constant-time: the comparison is against a value an attacker supplies.
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    return Number(expiresAt) > now;
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
