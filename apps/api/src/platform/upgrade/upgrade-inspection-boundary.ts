import { requireUpgrade } from './upgrade-trust';
type Json = Record<string, unknown>;
export function persistedBinding(value: Json): Json {
  const {
    inFlight: _requests,
    activeWS: _sockets,
    httpByDigest: _http,
    wsByDigest: _ws,
    ...persistent
  } = value;
  return persistent;
}

export function loopbackOrigin(value: unknown): string {
  requireUpgrade(typeof value === 'string', 'PRIVATE_ORIGIN_REQUIRED');
  const url = new URL(value);
  requireUpgrade(
    url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash,
    'PRIVATE_ORIGIN_REQUIRED',
  );
  return url.origin;
}
