import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '@platform/shared-kernel';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { readPublicNetworkConfig, parseHttpOrigin } from '../config/public-network';
import { readCookie } from './session-cookie';
import { PasscodeService } from './passcode.service';
import { requireUpgrade, upgradeDigest } from '../upgrade/upgrade-trust';

interface UpgradePrincipal {
  actorId: string;
  viewerId: string;
  canUpgrade: boolean;
  userScope: string;
  csrfToken: string;
}
const VIEWER_COOKIE = 'ap_upgrade_viewer';
const TTL = 7 * 24 * 60 * 60 * 1000;

/** Upgrades use the existing instance access policy; the automatic viewer binds CSRF and UI state. */
@Injectable()
export class UpgradeSecurity {
  private readonly secret: Buffer;
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly passcodes: PasscodeService,
  ) {
    if (this.passcodes.authorityEnabled) {
      this.secret = Buffer.alloc(0);
      return;
    }
    const pinned = process.env.UPGRADE_SESSION_SECRET;
    if (pinned) {
      requireUpgrade(pinned.length >= 32, 'UPGRADE_SESSION_SECRET_TOO_SHORT');
      this.secret = Buffer.from(pinned);
    } else if (env.databaseUrl === ':memory:') this.secret = randomBytes(32);
    else {
      mkdirSync(env.dataRoot, { recursive: true, mode: 0o700 });
      const path = join(env.dataRoot, '.upgrade-session-secret');
      if (!existsSync(path)) {
        try {
          writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
      }
      const stat = lstatSync(path);
      requireUpgrade(
        stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
        'INSECURE_UPGRADE_SESSION_SECRET',
      );
      chmodSync(path, 0o600);
      this.secret = readFileSync(path);
      requireUpgrade(this.secret.byteLength >= 32, 'UPGRADE_SESSION_SECRET_TOO_SHORT');
    }
  }
  // Retained for old Web clients: there is no separate authorization step.
  readonly canAuthenticate = false;
  continuityFingerprint(instanceId: string): string {
    requireUpgrade(!this.passcodes.authorityEnabled, 'ACCESS_AUTHORITY_ASYNC_REQUIRED', 503);
    return createHmac('sha256', this.secret)
      .update(`session-continuity:${instanceId}`)
      .digest('hex');
  }
  /** Optional migration aid for already installed releases. This key cannot authorize
   * a user or enable upgrades; new installations never need to create one. */
  private get legacyContinuityKey(): string | undefined {
    const key = process.env.UPGRADE_LEGACY_AUTH_CONTINUITY_KEY ?? process.env.UPGRADE_ADMIN_KEY;
    return key && key.length >= 32 ? key : undefined;
  }
  legacyContinuityFingerprint(instanceId: string): string | null {
    requireUpgrade(!this.passcodes.authorityEnabled, 'ACCESS_AUTHORITY_ASYNC_REQUIRED', 503);
    const legacy = this.legacyContinuityKey;
    return legacy
      ? createHmac('sha256', this.secret)
          .update(`session-continuity:${instanceId}:${legacy}`)
          .digest('hex')
      : null;
  }
  /** Sent directly to an accepted ControlAPI from the Coordinator; never returned
   * by management RPC, logged or persisted. This exercises real cookie parsing. */
  continuityChallenge(
    instanceId: string,
    legacyBaseline = false,
  ): { cookie: string; userScope: string; legacy: boolean } {
    requireUpgrade(!this.passcodes.authorityEnabled, 'ACCESS_AUTHORITY_ASYNC_REQUIRED', 503);
    const viewerId = this.ids.next(),
      expiresAt = this.clock.now().getTime() + 60_000;
    const viewer = this.sign({ instanceId, viewerId, expiresAt });
    const legacy = legacyBaseline ? this.legacyContinuityKey : undefined;
    const grant = legacy
      ? this.sign({
          instanceId,
          viewerId,
          capability: 'upgrade-instance',
          grantVersion: createHmac('sha256', this.secret).update(`grant:${legacy}`).digest('hex'),
          expiresAt,
        })
      : undefined;
    return {
      cookie: `${VIEWER_COOKIE}=${viewer}${grant ? `; ap_upgrade_grant=${grant}` : ''}`,
      legacy: grant !== undefined,
      userScope: createHmac('sha256', this.secret)
        .update(`scope:${instanceId}:${viewerId}`)
        .digest('hex'),
    };
  }
  async continuityEvidence(
    instanceId: string,
  ): Promise<{ fingerprint: string; legacyFingerprint: string | null; policyRevision: number }> {
    if (this.passcodes.authorityEnabled) {
      const value = await this.passcodes.authorityFingerprint();
      requireUpgrade(value.instanceId === instanceId, 'UPGRADE_INSTANCE_MISMATCH', 503);
      return value;
    }
    const access = this.passcodes.issueSessionToken(0),
      legacy = this.legacyContinuityFingerprint(instanceId);
    return {
      fingerprint: upgradeDigest({ upgrade: this.continuityFingerprint(instanceId), access }),
      legacyFingerprint: legacy ? upgradeDigest({ upgrade: legacy, access }) : null,
      policyRevision: 1,
    };
  }
  async continuityChallengeAsync(
    instanceId: string,
    legacyBaseline = false,
  ): Promise<{ cookie: string; userScope: string; legacy: boolean; policyRevision: number }> {
    if (this.passcodes.authorityEnabled) {
      const value = await this.passcodes.authorityChallenge(legacyBaseline);
      requireUpgrade(value.instanceId === instanceId, 'UPGRADE_INSTANCE_MISMATCH', 503);
      return value;
    }
    const value = this.continuityChallenge(instanceId, legacyBaseline);
    return {
      ...value,
      cookie: `${value.cookie}; ap_session=${encodeURIComponent(this.passcodes.issueCurrentSessionToken())}`,
      policyRevision: 1,
    };
  }
  private sign(payload: object): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${createHmac('sha256', this.secret).update(encoded).digest('base64url')}`;
  }
  private verify(token: string | undefined): Record<string, unknown> | null {
    if (!token || token.length > 4096) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const expected = createHmac('sha256', this.secret).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected))
      return null;
    try {
      const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (
        !value ||
        typeof value !== 'object' ||
        !('expiresAt' in value) ||
        typeof value.expiresAt !== 'number' ||
        value.expiresAt <= this.clock.now().getTime()
      )
        return null;
      return value;
    } catch {
      return null;
    }
  }
  private cookie(res: Response, name: string, value: string): void {
    const secure = process.env.PASSCODE_COOKIE_SECURE === 'true';
    res.append(
      'Set-Cookie',
      `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(TTL / 1000)}${secure ? '; Secure' : ''}`,
    );
  }
  principal(req: Request, res: Response, instanceId: string): UpgradePrincipal {
    if (this.passcodes.authorityEnabled) {
      requireUpgrade(
        instanceId === process.env.PLATFORM_INSTANCE_ID,
        'UPGRADE_INSTANCE_MISMATCH',
        503,
      );
      const decision = this.passcodes.authorityDecision(req);
      requireUpgrade(
        decision?.authorized && decision.principal,
        'ACCESS_AUTHORITY_REQUEST_REQUIRED',
        503,
      );
      if (decision.viewerCookie) res.append('Set-Cookie', decision.viewerCookie);
      return decision.principal;
    }
    let viewer = this.verify(readCookie(req, VIEWER_COOKIE));
    if (viewer?.instanceId !== instanceId || typeof viewer.viewerId !== 'string') {
      viewer = {
        instanceId,
        viewerId: this.ids.next(),
        expiresAt: this.clock.now().getTime() + TTL,
      };
      this.cookie(res, VIEWER_COOKIE, this.sign(viewer));
    }
    const viewerId = String(viewer.viewerId);
    const canUpgrade = this.passcodes.authenticatesRequest(req, this.clock.now().getTime());
    const actorId = canUpgrade ? 'instance-administrator' : `viewer-${viewerId}`;
    const userScope = createHmac('sha256', this.secret)
      .update(`scope:${instanceId}:${viewerId}`)
      .digest('hex');
    const csrfToken = createHmac('sha256', this.secret)
      .update(`csrf:${instanceId}:${viewerId}`)
      .digest('base64url');
    return { actorId, viewerId, canUpgrade, userScope, csrfToken };
  }
  mutation(req: Request, principal: UpgradePrincipal, requiresCapability = true): void {
    const origin =
      typeof req.headers.origin === 'string' ? parseHttpOrigin(req.headers.origin) : undefined;
    const allowed = readPublicNetworkConfig().allowedOrigins;
    const same = parseHttpOrigin(`${req.protocol}://${req.get('host') ?? ''}`);
    requireUpgrade(
      origin && (allowed.includes(origin) || (allowed.length === 0 && origin === same)),
      'UPGRADE_ORIGIN_INVALID',
      403,
    );
    const csrf = req.headers['x-upgrade-csrf'];
    const presented = Buffer.from(typeof csrf === 'string' ? csrf : '');
    const expected = Buffer.from(principal.csrfToken);
    requireUpgrade(
      presented.length === expected.length && timingSafeEqual(presented, expected),
      'UPGRADE_CSRF_INVALID',
      403,
    );
    requireUpgrade(!requiresCapability || principal.canUpgrade, 'UPGRADE_PERMISSION_REQUIRED', 403);
  }
  /** Deprecated compatibility endpoint. Existing instance access is sufficient;
   * legacy request bodies are accepted but never interpreted as credentials. */
  grant(
    req: Request,
    res: Response,
    instanceId: string,
    _legacyUpgradeKey?: string,
  ): UpgradePrincipal {
    const principal = this.principal(req, res, instanceId);
    this.mutation(req, principal);
    return principal;
  }
  internal(req: Request, instanceId: string): void {
    const remote = req.socket.remoteAddress;
    requireUpgrade(
      remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1',
      'UPGRADE_INTERNAL_ONLY',
      403,
    );
    const key = process.env.PLATFORM_CONTROLLER_RPC_KEY ?? '';
    const supplied = req.headers['x-platform-internal-key'];
    const actual = Buffer.from(typeof supplied === 'string' ? supplied : '');
    const expected = Buffer.from(key);
    requireUpgrade(
      key.length >= 32 && actual.length === expected.length && timingSafeEqual(actual, expected),
      'UPGRADE_INTERNAL_AUTH',
      403,
    );
    requireUpgrade(
      req.headers['x-platform-instance-id'] === instanceId,
      'UPGRADE_INSTANCE_MISMATCH',
      403,
    );
  }
}
