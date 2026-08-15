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
 * P1-1 regression: with ACCESS_PASSCODE set, the /terminal WS handshake MUST be
 * authenticated (the REST guard's non-HTTP self-exemption previously left it
 * open). Proves: no passcode → disconnect; correct passcode in the socket.io
 * `auth` → normal `session` frame. Uses the fake echo pty (no docker).
 */
const PASSCODE = 'test-passcode-xyz';
let app: INestApplication;
let port: number;

beforeAll(async () => {
  process.env.DATABASE_URL = ':memory:';
  process.env.ACCESS_PASSCODE = PASSCODE;
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
  delete process.env.ACCESS_PASSCODE;
});

function connect(query: Record<string, string>, auth?: Record<string, string>): Socket {
  return io(`http://127.0.0.1:${port}/terminal`, {
    query,
    auth,
    transports: ['websocket'],
    forceNew: true,
  });
}

function awaitDisconnect(sock: Socket): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 4000);
    sock.on('disconnect', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

function nextFrame(sock: Socket, pred: (f: TerminalServerFrame) => boolean): Promise<TerminalServerFrame> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('frame timeout')), 4000);
    const h = (f: TerminalServerFrame) => {
      if (pred(f)) {
        clearTimeout(t);
        sock.off('frame', h);
        resolve(f);
      }
    };
    sock.on('frame', h);
  });
}

describe('/terminal WS access-passcode gate (P1-1)', () => {
  it('refuses a handshake with NO passcode when ACCESS_PASSCODE is set', async () => {
    const sock = connect({ sandboxId: 'sbx-auth-1', xSchemaHash: WS_SCHEMA_HASH });
    try {
      expect(await awaitDisconnect(sock)).toBe(true);
    } finally {
      sock.disconnect();
    }
  });

  it('refuses a handshake with a WRONG passcode', async () => {
    const sock = connect({ sandboxId: 'sbx-auth-2', xSchemaHash: WS_SCHEMA_HASH }, { passcode: 'nope' });
    try {
      expect(await awaitDisconnect(sock)).toBe(true);
    } finally {
      sock.disconnect();
    }
  });

  it('accepts a handshake carrying the correct passcode and emits a session frame', async () => {
    const sock = connect(
      { sandboxId: 'sbx-auth-3', xSchemaHash: WS_SCHEMA_HASH },
      { passcode: PASSCODE },
    );
    try {
      const session = await nextFrame(sock, (f) => f.type === 'session');
      expect(session.type).toBe('session');
      if (session.type === 'session') {
        expect(session.socketSessionKey).toMatch(/^[0-9a-f]{32}$/);
      }
    } finally {
      sock.disconnect();
    }
  });
});

function connectEvents(auth?: Record<string, string>): Socket {
  return io(`http://127.0.0.1:${port}/events`, { auth, transports: ['websocket'], forceNew: true });
}

describe('/events WS access-passcode gate', () => {
  it('refuses a handshake with NO passcode when ACCESS_PASSCODE is set', async () => {
    const sock = connectEvents();
    try {
      expect(await awaitDisconnect(sock)).toBe(true);
    } finally {
      sock.disconnect();
    }
  });

  it('accepts a handshake carrying the correct passcode (stays connected)', async () => {
    const sock = connectEvents({ passcode: PASSCODE });
    try {
      const connected = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 4000);
        sock.on('connect', () => {
          clearTimeout(t);
          resolve(true);
        });
      });
      expect(connected).toBe(true);
    } finally {
      sock.disconnect();
    }
  });
});
