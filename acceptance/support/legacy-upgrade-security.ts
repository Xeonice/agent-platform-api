/** Frozen e624a4ce authorization implementation for actual old/new HTTP compatibility tests.
 * It is never installed as current production authorization. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '@platform/shared-kernel';
import type { UpgradeSecurity } from '../../apps/api/src/platform/access-passcode/upgrade-security.service';
type Request = Parameters<UpgradeSecurity['principal']>[0];
type Response = Parameters<UpgradeSecurity['principal']>[1];
import { env } from '../../apps/api/src/platform/config/env';
import {
  readPublicNetworkConfig,
  parseHttpOrigin,
} from '../../apps/api/src/platform/config/public-network';
import { readCookie } from '../../apps/api/src/platform/access-passcode/session-cookie';
import { requireUpgrade } from '../../apps/api/src/platform/upgrade/upgrade-trust';

interface UpgradePrincipal {
  actorId: string;
  viewerId: string;
  canUpgrade: boolean;
  userScope: string;
  csrfToken: string;
}
const VIEWER_COOKIE = 'ap_upgrade_viewer';
const GRANT_COOKIE = 'ap_upgrade_grant';
const TTL = 7 * 24 * 60 * 60 * 1000;

/** Independent installation authorization. The access passcode never grants this capability. */
@Injectable()
export class LegacyUpgradeSecurity {
  private readonly secret: Buffer;
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {
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
  get canAuthenticate(): boolean {
    return (process.env.UPGRADE_ADMIN_KEY ?? '').length >= 32;
  }
  continuityFingerprint(instanceId: string): string {
    return createHmac('sha256', this.secret)
      .update(`session-continuity:${instanceId}:${process.env.UPGRADE_ADMIN_KEY ?? ''}`)
      .digest('hex');
  }
  /** Sent directly to an accepted ControlAPI from the Coordinator; never returned
   * by management RPC, logged or persisted. This exercises real cookie parsing. */
  continuityChallenge(instanceId: string): { cookie: string; userScope: string } {
    const viewerId = this.ids.next(),
      expiresAt = this.clock.now().getTime() + 60_000;
    const viewer = this.sign({ instanceId, viewerId, expiresAt });
    const grantVersion = createHmac('sha256', this.secret)
      .update(`grant:${process.env.UPGRADE_ADMIN_KEY ?? ''}`)
      .digest('hex');
    const grant = this.sign({
      instanceId,
      viewerId,
      capability: 'upgrade-instance',
      grantVersion,
      expiresAt,
    });
    return {
      cookie: `${VIEWER_COOKIE}=${viewer}; ${GRANT_COOKIE}=${grant}`,
      userScope: createHmac('sha256', this.secret)
        .update(`scope:${instanceId}:${viewerId}`)
        .digest('hex'),
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
      return value as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  private cookie(res: Response, name: string, value: string): void {
    const secure = process.env.PASSCODE_COOKIE_SECURE === 'true';
    res.append(
      'Set-Cookie',
      `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL / 1000}${secure ? '; Secure' : ''}`,
    );
  }
  principal(req: Request, res: Response, instanceId: string): UpgradePrincipal {
    let viewer = this.verify(readCookie(req, VIEWER_COOKIE));
    if (!viewer || viewer.instanceId !== instanceId || typeof viewer.viewerId !== 'string') {
      viewer = {
        instanceId,
        viewerId: this.ids.next(),
        expiresAt: this.clock.now().getTime() + TTL,
      };
      this.cookie(res, VIEWER_COOKIE, this.sign(viewer));
    }
    const viewerId = String(viewer.viewerId);
    const grant = this.verify(readCookie(req, GRANT_COOKIE));
    const grantVersion = createHmac('sha256', this.secret)
      .update(`grant:${process.env.UPGRADE_ADMIN_KEY ?? ''}`)
      .digest('hex');
    const canUpgrade =
      this.canAuthenticate &&
      grant?.grantVersion === grantVersion &&
      grant?.instanceId === instanceId &&
      grant?.viewerId === viewerId &&
      grant?.capability === 'upgrade-instance';
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
  grant(req: Request, res: Response, instanceId: string, upgradeKey: string): UpgradePrincipal {
    const principal = this.principal(req, res, instanceId);
    this.mutation(req, principal, false);
    const installed = process.env.UPGRADE_ADMIN_KEY ?? '';
    const expected = createHmac('sha256', this.secret).update(installed).digest();
    const presented = createHmac('sha256', this.secret).update(upgradeKey).digest();
    requireUpgrade(
      this.canAuthenticate && timingSafeEqual(expected, presented),
      'UPGRADE_PERMISSION_REQUIRED',
      403,
    );
    const grantVersion = createHmac('sha256', this.secret)
      .update(`grant:${installed}`)
      .digest('hex');
    this.cookie(
      res,
      GRANT_COOKIE,
      this.sign({
        instanceId,
        viewerId: principal.viewerId,
        capability: 'upgrade-instance',
        grantVersion,
        expiresAt: this.clock.now().getTime() + TTL,
      }),
    );
    return { ...principal, actorId: 'instance-administrator', canUpgrade: true };
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
