import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { requireUpgrade } from './upgrade-trust';
/** Dedicated trusted loopback probe key cannot authorize general control RPCs. */
export function authorizeUpgradeProbe(req: Request, instanceId: string, legacy: () => void): void {
  const key = process.env.UPGRADE_BUSINESS_PROBE_KEY;
  if (!key) {
    legacy();
    return;
  }
  const remote = req.socket.remoteAddress;
  requireUpgrade(
    remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1',
    'UPGRADE_INTERNAL_ONLY',
    403,
  );
  const supplied = req.headers['x-platform-internal-key'],
    actual = Buffer.from(typeof supplied === 'string' ? supplied : ''),
    expected = Buffer.from(key);
  requireUpgrade(
    key.length >= 32 && actual.length === expected.length && timingSafeEqual(actual, expected),
    'UPGRADE_PROBE_AUTH',
    403,
  );
  requireUpgrade(
    req.headers['x-platform-instance-id'] === instanceId,
    'UPGRADE_INSTANCE_MISMATCH',
    403,
  );
}
