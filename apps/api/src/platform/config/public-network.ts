import { isAbsolute } from 'node:path';

export interface PublicNetworkConfig {
  readonly allowedOrigins: readonly string[];
  readonly trustProxy: 'none' | 'cloudflare-loopback';
  readonly drainFile?: string;
}

/** Exact origins only. No wildcard, URL credentials, path, query or fragment. */
export function parseHttpOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      raw.includes('?') ||
      raw.includes('#') ||
      raw.includes('*') ||
      raw === 'null'
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Validate before Nest opens SQLite or starts workers. Empty keeps local same-origin use. */
export function readPublicNetworkConfig(
  source: NodeJS.ProcessEnv = process.env,
): PublicNetworkConfig {
  const rawOrigins = (source['API_ALLOWED_ORIGINS'] ?? '').trim();
  const origins = rawOrigins === '' ? [] : rawOrigins.split(',').map((value) => value.trim());
  const allowedOrigins = origins.map((origin) => {
    const parsed = parseHttpOrigin(origin);
    if (!parsed) throw new Error('API_ALLOWED_ORIGINS must contain exact HTTP(S) origins');
    return parsed;
  });
  const trustProxy = source['API_TRUST_PROXY'] ?? 'none';
  const drainFile = (source['DEPLOYMENT_DRAIN_FILE'] ?? '').trim();
  if (drainFile !== '' && !isAbsolute(drainFile)) {
    throw new Error('DEPLOYMENT_DRAIN_FILE must be an absolute path');
  }
  if (trustProxy !== 'none' && trustProxy !== 'cloudflare-loopback') {
    throw new Error('API_TRUST_PROXY must be none or cloudflare-loopback');
  }
  if (trustProxy === 'cloudflare-loopback') {
    if (
      allowedOrigins.length === 0 ||
      allowedOrigins.some((origin) => !origin.startsWith('https:'))
    ) {
      throw new Error('cloudflare-loopback requires explicit HTTPS API_ALLOWED_ORIGINS');
    }
    if (!['127.0.0.1', '::1', 'localhost'].includes(source['HOST'] ?? '127.0.0.1')) {
      throw new Error('cloudflare-loopback requires a loopback HOST');
    }
    if (source['ACCESS_PASSCODE_ALLOW_LOOPBACK'] === 'true') {
      throw new Error('cloudflare-loopback cannot enable ACCESS_PASSCODE_ALLOW_LOOPBACK');
    }
    if (source['PASSCODE_COOKIE_SECURE'] !== 'true') {
      throw new Error('cloudflare-loopback requires PASSCODE_COOKIE_SECURE=true');
    }
  }
  return {
    allowedOrigins: [...new Set(allowedOrigins)],
    trustProxy,
    ...(drainFile ? { drainFile } : {}),
  };
}
