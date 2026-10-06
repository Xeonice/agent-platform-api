import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { PublicNetworkConfig } from '../config/public-network';

function normalizedIp(value: string): string {
  const unwrapped = value.startsWith('::ffff:') ? value.slice(7) : value;
  if (isIP(unwrapped) !== 6) return unwrapped;
  // Canonicalize IPv6 so alternate spellings cannot get independent rate-limit buckets.
  try {
    return new URL(`http://[${unwrapped}]`).hostname.slice(1, -1);
  } catch {
    return unwrapped;
  }
}

/** X-Forwarded-For/Forwarded/X-Real-IP are deliberately never trusted. */
export function requestClientIp(req: IncomingMessage, config: PublicNetworkConfig): string {
  const address = req.socket.remoteAddress;
  const peer = address === undefined ? 'unknown' : normalizedIp(address);
  const local = peer === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(peer);
  if (config.trustProxy === 'cloudflare-loopback' && local) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && !cf.includes('%') && isIP(cf) !== 0) return normalizedIp(cf);
  }
  // Missing, malformed, duplicate/comma-separated CF values all share the real peer bucket.
  return peer;
}
