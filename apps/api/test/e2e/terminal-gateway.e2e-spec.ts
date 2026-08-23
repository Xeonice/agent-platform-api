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
    // a middleware refusal must be observed ONCE, not retried behind the assertion
    reconnection: false,
  });
}

function awaitConnectError(sock: Socket): Promise<Error> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no connect_error')), 4000);
    sock.on('connect_error', (e: Error) => {
      clearTimeout(t);
      resolve(e);
    });
    sock.on('connect', () => {
      clearTimeout(t);
      reject(new Error('handshake was ACCEPTED'));
    });
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

  /**
   * ⚠️ THE REFUSAL IS A `connect_error`, NOT A DISCONNECT, AND THAT IS THE POINT.
   * While this gateway accepted the socket and then called `disconnect(true)`, the
   * client saw a connection that opened and closed — indistinguishable from a network
   * blip — so the one thing the X-Schema-Hash handshake exists to report could not be
   * reported. Asserting "the socket went away" passed under BOTH behaviours, which is
   * why the old shape survived this test.
   */
  it('refuses a mismatched X-Schema-Hash with SCHEMA_MISMATCH on connect_error', async () => {
    const sock = connect({ sandboxId: 'sbx-term-2', xSchemaHash: 'deadbeefdeadbeef' });
    try {
      const err = await awaitConnectError(sock);
      expect(err.message.startsWith('SCHEMA_MISMATCH')).toBe(true);
      expect((err as Error & { data?: { code?: string } }).data?.code).toBe('SCHEMA_MISMATCH');
      // ⚠️ AND IT MUST NOT LOOK LIKE AN AUTH FAILURE. The client's shared matcher falls
      // back to this prose regex, and a version drift shown as "unauthorized" sends the
      // user to the unlock dialog — which cannot fix a version drift.
      expect(err.message).not.toMatch(/unauthor|forbidden|passcode|401|403/i);
    } finally {
      sock.disconnect();
    }
  });

  it('refuses a handshake that OMITS the hash — required, not checked-if-present', async () => {
    // The old rule was `presented && presented !== …`, so it only ever caught a client
    // that was already careful enough to send one. The frontend does send it, so the
    // only clients this admitted were the ones nobody could vouch for.
    const sock = connect({ sandboxId: 'sbx-term-3' });
    try {
      const err = await awaitConnectError(sock);
      expect(err.message.startsWith('SCHEMA_MISMATCH')).toBe(true);
      expect(err.message).toContain('none');
    } finally {
      sock.disconnect();
    }
  });

  it('refuses a handshake with no sandboxId as SANDBOX_REQUIRED — not as UNAUTHORIZED', async () => {
    // A missing query parameter is an ADDRESSING fault; naming it "unauthorized" would
    // both misreport it and route the user to a dialog that cannot add a parameter.
    const sock = connect({ xSchemaHash: WS_SCHEMA_HASH });
    try {
      const err = await awaitConnectError(sock);
      expect(err.message.startsWith('SANDBOX_REQUIRED')).toBe(true);
      expect(err.message).not.toMatch(/unauthor|forbidden|passcode|401|403/i);
    } finally {
      sock.disconnect();
    }
  });
});
