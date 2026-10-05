import { describe, expect, it } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { readPublicNetworkConfig } from '../../../apps/api/src/platform/config/public-network';
import { requestClientIp } from '../../../apps/api/src/platform/access-passcode/client-ip';

const publicEnv = {
  API_ALLOWED_ORIGINS: 'https://agent.douglasdong.com, https://agent-api.douglasdong.com',
  API_TRUST_PROXY: 'cloudflare-loopback',
  PASSCODE_COOKIE_SECURE: 'true',
  HOST: '127.0.0.1',
};

describe('Deployment public-network configuration', () => {
  it('accepts explicit HTTPS sibling origins, canonicalizes duplicates and defaults to no proxy trust', () => {
    expect(readPublicNetworkConfig(publicEnv)).toMatchObject({
      allowedOrigins: ['https://agent.douglasdong.com', 'https://agent-api.douglasdong.com'],
      trustProxy: 'cloudflare-loopback',
    });
    expect(
      readPublicNetworkConfig({ API_ALLOWED_ORIGINS: 'https://app.example/,https://app.example' }),
    ).toEqual({ allowedOrigins: ['https://app.example'], trustProxy: 'none' });
    expect(readPublicNetworkConfig({})).toEqual({ allowedOrigins: [], trustProxy: 'none' });
  });

  it.each([
    'https://*.example.com',
    'null',
    'https://app.example/path',
    'https://user@api.example',
    'https://app.example?query=1',
    'https://app.example#section',
    'https://app.example?',
    'https://app.example#',
    'https://app.example,',
    'ws://app.example',
  ])('refuses an ambiguous or non-origin declaration: %s', (origin) => {
    expect(() => readPublicNetworkConfig({ API_ALLOWED_ORIGINS: origin })).toThrow(
      'API_ALLOWED_ORIGINS',
    );
  });

  it.each([
    { API_TRUST_PROXY: 'true' },
    { API_ALLOWED_ORIGINS: '' },
    { API_ALLOWED_ORIGINS: 'http://app.example' },
    { HOST: '0.0.0.0' },
    { ACCESS_PASSCODE_ALLOW_LOOPBACK: 'true' },
    { PASSCODE_COOKIE_SECURE: 'false' },
  ])('refuses unsafe public proxy deployment before app construction: %j', (patch) => {
    expect(() => readPublicNetworkConfig({ ...publicEnv, ...patch })).toThrow();
  });

  it('never trusts CF client IP from a remote peer, nor forwarded chains; canonicalizes accepted IPv6', () => {
    const req = new IncomingMessage(new Socket());
    Object.defineProperty(req.socket, 'remoteAddress', {
      value: '198.51.100.40',
      configurable: true,
    });
    req.headers = { 'cf-connecting-ip': '192.0.2.5', 'x-forwarded-for': '192.0.2.6' };
    const config = readPublicNetworkConfig(publicEnv);
    expect(requestClientIp(req, config)).toBe('198.51.100.40');
    Object.defineProperty(req.socket, 'remoteAddress', { value: '::ffff:127.0.0.1' });
    expect(requestClientIp(req, config)).toBe('192.0.2.5');
    expect(requestClientIp(req, { ...config, trustProxy: 'none' })).toBe('127.0.0.1');
    req.headers['cf-connecting-ip'] = '2001:0db8:0000:0000:0000:0000:0000:0001';
    expect(requestClientIp(req, config)).toBe('2001:db8::1');
    for (const value of [
      '192.0.2.1, 192.0.2.2',
      'invalid',
      'fe80::1%en0',
      ['192.0.2.1', '192.0.2.2'],
    ]) {
      req.headers['cf-connecting-ip'] = value;
      expect(requestClientIp(req, config)).toBe('127.0.0.1');
    }
    req.socket.destroy();
  });

  it('rejects a relative deployment barrier so changing release directories cannot lose the gate', () => {
    expect(() => readPublicNetworkConfig({ DEPLOYMENT_DRAIN_FILE: './drain' })).toThrow('absolute');
    expect(
      readPublicNetworkConfig({ DEPLOYMENT_DRAIN_FILE: '/var/run/agent-platform/drain' }).drainFile,
    ).toBe('/var/run/agent-platform/drain');
  });
});
