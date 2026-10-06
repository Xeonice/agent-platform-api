import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { io } from 'socket.io-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer, request as upstreamRequest } from 'node:http';
import { createPlatform } from '../../support/platform-app';

const APP = 'https://agent.douglasdong.com';
const API = 'https://agent-api.douglasdong.com';
const PASSCODE = 'synthetic-public-network-passcode';
const publicEnv = {
  API_ALLOWED_ORIGINS: `${APP},${API}`,
  API_TRUST_PROXY: 'cloudflare-loopback',
  PASSCODE_COOKIE_SECURE: 'true',
  ACCESS_PASSCODE_ALLOW_LOOPBACK: 'false',
  ACCESS_PASSCODE: PASSCODE,
  HOST: '127.0.0.1',
};

function handshake(url: string, headers: Record<string, string>) {
  const socket = io(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    timeout: 3000,
    extraHeaders: headers,
  });
  return new Promise<{ connected: boolean; message?: string; description?: string }>((resolve) => {
    socket.once('connect', () => resolve({ connected: true }));
    socket.once('connect_error', (error: Error) => {
      const description = 'description' in error ? error.description : undefined;
      resolve({
        connected: false,
        message: error.message,
        description:
          typeof description === 'object' && description !== null && 'message' in description
            ? String(description.message)
            : String(description),
      });
    });
  }).finally(() => socket.disconnect());
}

describe('Real Nest HTTP/MCP/WebSocket behind the declared local Cloudflare proxy', () => {
  it('credentialed JSON preflight precedes authentication; allowed-origin unlock sets a secure API-host cookie', async () => {
    const h = await createPlatform(publicEnv);
    try {
      const server = h.app.getHttpServer();
      const preflight = await request(server)
        .options('/api/access/unlock')
        .set('Origin', APP)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,x-access-passcode')
        .expect(204);
      expect(preflight.headers).toMatchObject({
        'access-control-allow-origin': APP,
        'access-control-allow-credentials': 'true',
      });
      expect(preflight.headers['access-control-allow-headers'].toLowerCase()).toContain(
        'content-type',
      );
      expect(preflight.headers['vary']).toContain('Origin');
      const locked = await request(server).get('/api/projects').set('Origin', APP).expect(401);
      expect(locked.headers['access-control-allow-origin']).toBe(APP);
      const unlocked = await request(server)
        .post('/api/access/unlock')
        .set('Origin', APP)
        .send({ passcode: PASSCODE })
        .expect(200);
      const cookie = unlocked.headers['set-cookie'][0];
      expect(cookie).toMatch(/HttpOnly; SameSite=Lax; Path=\/; Max-Age=604800; Secure/);
      expect(cookie).not.toMatch(/Domain=/i);
      const read = await request(server)
        .get('/api/projects')
        .set('Origin', APP)
        .set('Cookie', cookie.split(';')[0])
        .expect(200);
      expect(read.headers['access-control-expose-headers'].toLowerCase()).toBe(
        'x-schema-hash,content-disposition,content-length',
      );
      expect(
        await handshake(`${h.url}/events`, { Origin: APP, Cookie: cookie.split(';')[0] }),
      ).toEqual({ connected: true });
      expect(await handshake(`${h.url}/events`, { Origin: APP })).toMatchObject({
        connected: false,
        message: 'UNAUTHORIZED: missing or invalid access passcode',
      });
    } finally {
      await h.close();
    }
  });

  it('refuses foreign, opaque and misleading origins before writes; rejects actual websocket upgrades across namespaces', async () => {
    const h = await createPlatform(publicEnv);
    try {
      const server = h.app.getHttpServer();
      const unlocked = await request(server)
        .post('/api/access/unlock')
        .set('Origin', APP)
        .send({ passcode: PASSCODE })
        .expect(200);
      const cookie = unlocked.headers['set-cookie'][0].split(';')[0];
      for (const origin of [
        'https://evil.example',
        'null',
        `${APP}.evil.example`,
        'https://preview.vercel.app',
        'http://localhost:3000',
      ]) {
        const denied = await request(server)
          .post('/api/projects')
          .set('Origin', origin)
          .set('Cookie', cookie)
          .send({ name: 'must not exist', sourceType: 'empty' })
          .expect(403);
        expect(denied.body).toMatchObject({
          code: 'FORBIDDEN',
          retryable: false,
          sideEffectFree: true,
        });
        expect(denied.headers['access-control-allow-origin']).toBeUndefined();
        await request(server)
          .options('/api/access/unlock')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST')
          .expect(403);
      }
      const missing = await request(server)
        .post('/api/projects')
        .set('Sec-Fetch-Site', 'same-site')
        .set('Cookie', cookie)
        .send({ name: 'must not exist', sourceType: 'empty' })
        .expect(403);
      expect(missing.body.sideEffectFree).toBe(true);
      expect(
        (await request(server).get('/api/projects').set('Origin', APP).set('Cookie', cookie)).body,
      ).toEqual([]);
      for (const namespace of ['/events', '/terminal', '/tasks']) {
        const denied = await handshake(`${h.url}${namespace}`, {
          Origin: 'https://evil.example',
          Cookie: cookie,
        });
        expect(denied).toMatchObject({ connected: false, message: 'websocket error' });
        // Engine.IO's websocket abortUpgrade uses 400 even for its FORBIDDEN code.
        expect(denied.description).toContain('400');
      }
      const transportDenied = await request(server)
        .get('/socket.io/?EIO=4&transport=polling')
        .set('Origin', 'https://evil.example')
        .expect(403);
      expect(transportDenied.body).toMatchObject({ code: 4, message: 'Origin is not allowed' });
    } finally {
      await h.close();
    }
  });

  it('shares header/unlock limits per trusted CF visitor, ignores spoofed forwarded chains and never grants local-peer auth bypass', async () => {
    const h = await createPlatform(publicEnv);
    try {
      const server = h.app.getHttpServer();
      await request(server).get('/api/projects').set('CF-Connecting-IP', '192.0.2.10').expect(401);
      for (let attempt = 0; attempt < 5; attempt++) {
        await request(server)
          .get('/api/projects')
          .set('CF-Connecting-IP', '192.0.2.10')
          .set('X-Forwarded-For', `198.51.100.${attempt}`)
          .set('X-Access-Passcode', 'wrong')
          .expect(401);
      }
      await request(server)
        .post('/api/access/unlock')
        .set('CF-Connecting-IP', '192.0.2.10')
        .send({ passcode: PASSCODE })
        .expect(429);
      await request(server)
        .post('/api/access/unlock')
        .set('CF-Connecting-IP', '192.0.2.11')
        .send({ passcode: PASSCODE })
        .expect(200);
      for (let attempt = 0; attempt < 5; attempt++) {
        await request(server)
          .post('/api/access/unlock')
          .set('CF-Connecting-IP', 'not-an-ip')
          .set('X-Forwarded-For', `203.0.113.${attempt}`)
          .send({ passcode: 'wrong' })
          .expect(401);
      }
      await request(server)
        .post('/api/access/unlock')
        .set('X-Forwarded-For', '203.0.113.250')
        .send({ passcode: PASSCODE })
        .expect(429);
    } finally {
      await h.close();
    }
  });

  it('keeps no-Origin bearer-authenticated MCP and cookie HTTP/WS CLI clients functional', async () => {
    const h = await createPlatform(publicEnv);
    const client = new Client(
      { name: 'public-network-acceptance', version: '1' },
      { capabilities: {} },
    );
    try {
      const server = h.app.getHttpServer();
      const unlocked = await request(server)
        .post('/api/access/unlock')
        .send({ passcode: PASSCODE })
        .expect(200);
      const cookie = unlocked.headers['set-cookie'][0].split(';')[0];
      const created = await request(server)
        .post('/api/projects')
        .set('Cookie', cookie)
        .send({ name: 'authenticated CLI', sourceType: 'empty' })
        .expect(202);
      expect(created.body.cloneStatus).toBe('ready');
      expect(await handshake(`${h.url}/events`, { Cookie: cookie })).toEqual({ connected: true });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${h.url}/api/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${PASSCODE}` } },
        }),
      );
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('create_project');
      const result = await client.callTool({
        name: 'create_project',
        arguments: { name: 'MCP CLI', sourceType: 'empty' },
      });
      expect(result.isError).not.toBe(true);
      expect((await request(server).get('/api/projects').set('Cookie', cookie)).body).toHaveLength(
        2,
      );
    } finally {
      await client.close();
      await h.close();
    }
  });

  it('leaves local same-origin use available without public configuration while rejecting cross-origin writes', async () => {
    const h = await createPlatform({ API_ALLOWED_ORIGINS: undefined, API_TRUST_PROXY: undefined });
    try {
      await request(h.url)
        .post('/api/projects')
        .set('Origin', h.url)
        .send({ name: 'local same origin', sourceType: 'empty' })
        .expect(202);
      await request(h.app.getHttpServer())
        .post('/api/projects')
        .set('Origin', APP)
        .send({ name: 'foreign', sourceType: 'empty' })
        .expect(403);
      expect(await handshake(`${h.url}/events`, { Origin: h.url })).toEqual({ connected: true });
    } finally {
      await h.close();
    }
  });

  it('preserves the original local Next rewrite topology when the real proxy changes Host but retains browser Origin', async () => {
    const h = await createPlatform({ API_ALLOWED_ORIGINS: undefined, API_TRUST_PROXY: undefined });
    const target = new URL(h.url);
    const proxy = createServer((incoming, response) => {
      const upstream = upstreamRequest(
        new URL(incoming.url ?? '/', target),
        {
          method: incoming.method,
          headers: { ...incoming.headers, host: target.host },
        },
        (result) => {
          response.writeHead(result.statusCode ?? 502, result.headers);
          result.pipe(response);
        },
      );
      upstream.on('error', () => response.end());
      incoming.pipe(upstream);
    });
    try {
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const address = proxy.address();
      if (!address || typeof address === 'string') throw new Error('Proxy did not bind');
      const origin = `http://127.0.0.1:${address.port}`;
      const created = await request(origin)
        .post('/api/projects')
        .set('Origin', origin)
        .send({ name: 'local proxy creation', sourceType: 'empty' })
        .expect(202);
      expect(created.body.cloneStatus).toBe('ready');
      expect(created.headers['access-control-allow-origin']).toBe(origin);
      await request(origin)
        .post('/api/projects')
        .set('Origin', 'https://evil.example')
        .set('X-Forwarded-Host', 'evil.example')
        .set('X-Forwarded-Proto', 'https')
        .send({ name: 'forged forwarding', sourceType: 'empty' })
        .expect(403);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await h.close();
    }
  });
});
