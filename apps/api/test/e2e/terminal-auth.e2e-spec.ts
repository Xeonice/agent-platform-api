import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { SANDBOX_PTY_PORT, WS_SCHEMA_HASH, WS_TASKS_SCHEMA_HASH } from '@platform/contracts';
import type { TerminalServerFrame } from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { expectPasscodeEnabled, useEnv } from './_env';
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
let restoreEnv: () => void;

beforeAll(async () => {
  restoreEnv = useEnv({ DATABASE_URL: ':memory:', ACCESS_PASSCODE: PASSCODE });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PTY_PORT)
    .useValue(fakePtyPort)
    .compile();
  app = moduleRef.createNestApplication();
  setupWebsockets(app);
  await app.init();
  // the whole point of this spec is that the WS handshake is passcode-gated, so make
  // the precondition explicit instead of letting a leaked env silently open it up.
  expectPasscodeEnabled(app, true);
  await app.listen(0);
  const addr = app.getHttpServer().address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await app?.close();
  restoreEnv?.();
});

function connect(query: Record<string, string>, auth?: Record<string, string>): Socket {
  return io(`http://127.0.0.1:${port}/terminal`, {
    query,
    auth,
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
}

function nextFrame(
  sock: Socket,
  pred: (f: TerminalServerFrame) => boolean,
): Promise<TerminalServerFrame> {
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

/**
 * ⚠️ THESE USED TO ASSERT "the socket disconnected", AND THAT IS WHY THE PRODUCT BUG
 * SURVIVED THEM. `disconnect(true)` and a middleware refusal both make the socket go
 * away, so the assertion could not tell them apart — but the CLIENT can only recognise
 * an unauthorized handshake from `connect_error`, so with `disconnect(true)` the unlock
 * dialog never opened and the terminal just reconnected forever behind the passcode
 * gate. What is asserted now is the thing the frontend actually reads.
 */
describe('/terminal WS access-passcode gate (P1-1)', () => {
  it('refuses a handshake with NO passcode, and says UNAUTHORIZED', async () => {
    const sock = connect({ sandboxId: 'sbx-auth-1', xSchemaHash: WS_SCHEMA_HASH });
    try {
      const err = await awaitConnectError(sock);
      expect(err.message.startsWith('UNAUTHORIZED')).toBe(true);
      expect((err as Error & { data?: { code?: string } }).data?.code).toBe('UNAUTHORIZED');
      // the client's shared matcher must recognise THIS one (and only this one).
      expect(err.message).toMatch(/unauthor|forbidden|passcode|401|403/i);
    } finally {
      sock.disconnect();
    }
  });

  it('refuses a handshake with a WRONG passcode the same way', async () => {
    const sock = connect(
      { sandboxId: 'sbx-auth-2', xSchemaHash: WS_SCHEMA_HASH },
      { passcode: 'nope' },
    );
    try {
      expect((await awaitConnectError(sock)).message.startsWith('UNAUTHORIZED')).toBe(true);
    } finally {
      sock.disconnect();
    }
  });

  it('checks auth BEFORE the hash, so the codes cannot fingerprint the server', async () => {
    // wrong hash AND no passcode ⇒ the answer is the auth one: an unauthenticated
    // caller learns nothing about which protocol version this server speaks.
    const sock = connect({ sandboxId: 'sbx-auth-4', xSchemaHash: 'sb-terminal-FROM-THE-FUTURE' });
    try {
      expect((await awaitConnectError(sock)).message.startsWith('UNAUTHORIZED')).toBe(true);
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
  return io(`http://127.0.0.1:${port}/events`, {
    auth,
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
}

describe('/events WS access-passcode gate', () => {
  /**
   * ⚠️ THE SAME CORRECTION, AND HERE IT MATTERED MOST. `/events` is the only realtime
   * projection source in the product, and it deliberately never stops retrying — so a
   * refusal the client could not classify produced an endless silent reconnect with the
   * whole workbench frozen on 「启动中…」 and no unlock dialog in sight.
   */
  it('refuses a handshake with NO passcode, and says UNAUTHORIZED', async () => {
    const sock = connectEvents();
    try {
      const err = await awaitConnectError(sock);
      expect(err.message.startsWith('UNAUTHORIZED')).toBe(true);
      expect((err as Error & { data?: { code?: string } }).data?.code).toBe('UNAUTHORIZED');
      expect(err.message).toMatch(/unauthor|forbidden|passcode|401|403/i);
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

function connectTasks(query: Record<string, string>, auth?: Record<string, string>): Socket {
  return io(`http://127.0.0.1:${port}/tasks`, {
    query,
    auth,
    transports: ['websocket'],
    forceNew: true,
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

/**
 * `/tasks` carries agent OUTPUT — in general the contents of a private repository — so
 * its handshake is passcode-gated exactly like the other two namespaces.
 *
 * ⚠️ IT REFUSES IN MIDDLEWARE, so the refusal arrives as `connect_error` with a
 * MACHINE-READABLE code rather than as a frame on a socket that is being torn down. The
 * code matters: the client's shared "is this unauthorized?" helper is a prose regex, so
 * `UNAUTHORIZED` must match it while `SCHEMA_MISMATCH` and `SANDBOX_REQUIRED` must NOT —
 * a version drift, or a forgotten query parameter, read as an auth failure pops the
 * unlock dialog, which cannot possibly fix either.
 *
 * The accepting handshakes below therefore also carry `sandboxId`: it is a REQUIRED part
 * of the `/tasks` handshake, so a socket without one never gets far enough to prove
 * anything about the passcode.
 */
describe('/tasks WS access-passcode gate', () => {
  it('refuses a handshake with NO passcode, and says UNAUTHORIZED', async () => {
    // fully-formed apart from the credential: right hash, a declared sandbox — so the
    // refusal can only be about the passcode.
    const sock = connectTasks({ xSchemaHash: WS_TASKS_SCHEMA_HASH, sandboxId: 'sbx-scope' });
    try {
      const err = await awaitConnectError(sock);
      expect(err.message.startsWith('UNAUTHORIZED')).toBe(true);
      expect((err as Error & { data?: { code?: string } }).data?.code).toBe('UNAUTHORIZED');
      // the client's shared matcher must recognise this one.
      expect(err.message).toMatch(/unauthor|forbidden|passcode|401|403/i);
    } finally {
      sock.disconnect();
    }
  });

  it('refuses a WRONG passcode the same way', async () => {
    const sock = connectTasks({ xSchemaHash: WS_TASKS_SCHEMA_HASH }, { passcode: 'nope' });
    try {
      expect((await awaitConnectError(sock)).message.startsWith('UNAUTHORIZED')).toBe(true);
    } finally {
      sock.disconnect();
    }
  });

  it('checks auth BEFORE everything else, so the codes cannot fingerprint the server', async () => {
    // wrong hash AND no declared sandbox AND no passcode ⇒ the answer is the auth one;
    // an unauthenticated caller learns nothing about which protocol version this server
    // speaks, nor which of its query parameters it cares about.
    const sock = connectTasks({ xSchemaHash: 'sb-tasks-FROM-THE-FUTURE' });
    try {
      expect((await awaitConnectError(sock)).message.startsWith('UNAUTHORIZED')).toBe(true);
    } finally {
      sock.disconnect();
    }
  });

  it('accepts the correct passcode with the right hash', async () => {
    const sock = connectTasks(
      { xSchemaHash: WS_TASKS_SCHEMA_HASH, sandboxId: 'sbx-scope' },
      { passcode: PASSCODE },
    );
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
