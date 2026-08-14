import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { SANDBOX_PTY_PORT, WS_SCHEMA_HASH } from '@platform/contracts';
import type { TerminalServerFrame } from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { setupWebsockets } from '../../src/bootstrap/websocket.setup';
import { fakePtyPort } from './_fakes';

/**
 * /terminal gateway e2e over a REAL socket.io connection but a FAKE echo pty (no
 * docker). Proves: server-generated `socketSessionKey` first frame (audit P2-9),
 * the shared/10 §7.4 frame protocol (data/pong), and X-Schema-Hash handshake.
 */
let app: INestApplication;
let port: number;

beforeAll(async () => {
  process.env.DATABASE_URL = ':memory:';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PTY_PORT)
    .useValue(fakePtyPort)
    .compile();
  app = moduleRef.createNestApplication();
  setupWebsockets(app);
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await app?.close();
});

function connect(query: Record<string, string>): Socket {
  return io(`http://127.0.0.1:${port}/terminal`, {
    query,
    transports: ['websocket'],
    forceNew: true,
  });
}

function nextFrame(
  sock: Socket,
  predicate: (f: TerminalServerFrame) => boolean,
): Promise<TerminalServerFrame> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('frame timeout')), 4000);
    const handler = (f: TerminalServerFrame) => {
      if (predicate(f)) {
        clearTimeout(t);
        sock.off('frame', handler);
        resolve(f);
      }
    };
    sock.on('frame', handler);
  });
}

describe('/terminal socket.io gateway', () => {
  it('sends a server-generated session key, echoes input, answers ping', async () => {
    const sock = connect({ sandboxId: 'sbx-term-1', xSchemaHash: WS_SCHEMA_HASH });
    try {
      const session = await nextFrame(sock, (f) => f.type === 'session');
      expect(session.type).toBe('session');
      if (session.type === 'session') {
        expect(session.socketSessionKey).toMatch(/^[0-9a-f]{32}$/); // 128-bit hex, server-generated
      }

      sock.emit('frame', { type: 'input', data: 'ls /\n' });
      const data = await nextFrame(sock, (f) => f.type === 'data' && f.data.includes('ls /'));
      expect(data.type).toBe('data');

      sock.emit('frame', { type: 'ping' });
      const pong = await nextFrame(sock, (f) => f.type === 'pong');
      expect(pong.type).toBe('pong');
    } finally {
      sock.disconnect();
    }
  });

  it('refuses a handshake with a mismatched X-Schema-Hash', async () => {
    const sock = connect({ sandboxId: 'sbx-term-2', xSchemaHash: 'deadbeefdeadbeef' });
    try {
      const disconnected = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 4000);
        sock.on('disconnect', () => {
          clearTimeout(t);
          resolve(true);
        });
      });
      expect(disconnected).toBe(true);
    } finally {
      sock.disconnect();
    }
  });
});
