import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import {
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
  PROJECT_FACADE,
  WS_SCHEMA_HASH,
} from '@platform/contracts';
import type { SandboxWsEvent, TerminalServerFrame } from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { useEnv } from './_env';
import { setupWebsockets } from '../../src/bootstrap/websocket.setup';
import { platformValidationPipe } from '../../src/bootstrap/validation.pipe';
import { fakeProjectFacade, fakeWorkspace, makeFakeRegistry } from './_fakes';

/**
 * /events WS push leg (shared/10 §7.4, 26 §10). Boots the whole app on in-memory
 * doubles (no docker), connects a client to the `/events` namespace, then
 * `POST /api/sandboxes` and proves the client receives the projected sequence
 * `sandbox.created` → `sandbox.status_changed` (pending → … → running) — i.e. the
 * async create is driven to `running` over WS. Also proves the terminal connects
 * once running.
 */
let app: INestApplication;
let port: number;
let restoreEnv: () => void;

beforeAll(async () => {
  // `ACCESS_PASSCODE: undefined` UNSETS it for this spec (/events auth open in dev)
  // and restores whatever was there before — a bare delete would not (_env.ts).
  restoreEnv = useEnv({ DATABASE_URL: ':memory:', ACCESS_PASSCODE: undefined });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER_REGISTRY)
    .useValue(makeFakeRegistry())
    .overrideProvider(WORKSPACE_PREPARER)
    .useValue(fakeWorkspace)
    .overrideProvider(PROJECT_FACADE)
    .useValue(fakeProjectFacade)
    .compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(platformValidationPipe());
  setupWebsockets(app);
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await app?.close();
  restoreEnv?.();
});

function connect(namespace: string, query?: Record<string, string>): Promise<Socket> {
  const sock = io(`http://127.0.0.1:${port}${namespace}`, {
    query,
    transports: ['websocket'],
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`connect timeout ${namespace}`)), 4000);
    sock.on('connect', () => {
      clearTimeout(t);
      resolve(sock);
    });
    sock.on('connect_error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

describe('/events realtime sandbox state push', () => {
  it('streams sandbox.created + status_changed(pending→running) for an async create', async () => {
    const events = await connect('/events');
    const received: SandboxWsEvent[] = [];
    const sawRunning = new Promise<void>((resolve) => {
      events.on('event', (e: SandboxWsEvent) => {
        received.push(e);
        if (e.event === 'sandbox.status_changed' && e.status === 'running') resolve();
      });
    });

    // async create → immediate pending; provision advances in the background.
    const created = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: 'prj-events', runtime: 'claude-code' })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.status).toBe('pending');

    await Promise.race([
      sawRunning,
      new Promise((_r, rej) => setTimeout(() => rej(new Error('never saw running')), 5000)),
    ]);

    // sandbox.created carries the id + project
    const createdEv = received.find((e) => e.event === 'sandbox.created');
    expect(createdEv).toMatchObject({
      event: 'sandbox.created',
      sandboxId: id,
      projectId: 'prj-events',
    });

    // `sandbox.created` conveys the pending creation; `status_changed` then carries
    // every subsequent transition, in order, ending at running.
    const statuses = received
      .filter(
        (e): e is Extract<SandboxWsEvent, { event: 'sandbox.status_changed' }> =>
          e.event === 'sandbox.status_changed',
      )
      .map((e) => e.status);
    expect(statuses[statuses.length - 1]).toBe('running');
    expect(statuses).toEqual([
      'scheduling',
      'preparing-workspace',
      'creating',
      'starting',
      'running',
    ]);

    // terminal is reachable now that the sandbox is running. The `session` frame is
    // emitted on connect, so attach the listener BEFORE the socket connects.
    const term = io(`http://127.0.0.1:${port}/terminal`, {
      query: { sandboxId: id, xSchemaHash: WS_SCHEMA_HASH },
      transports: ['websocket'],
      forceNew: true,
    });
    const session = await new Promise<TerminalServerFrame>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no session frame')), 4000);
      term.on('frame', (f: TerminalServerFrame) => {
        if (f.type === 'session') {
          clearTimeout(t);
          resolve(f);
        }
      });
    });
    if (session.type === 'session') expect(session.socketSessionKey).toMatch(/^[0-9a-f]{32}$/);

    term.disconnect();
    events.disconnect();
  });

  it('destroy pushes status_changed(destroyed) + sandbox.removed', async () => {
    const events = await connect('/events');
    // attach the collector BEFORE creating, so no event is missed.
    let sandboxId = '';
    let onRunning: () => void = () => undefined;
    let onRemoved: () => void = () => undefined;
    const running = new Promise<void>((res) => (onRunning = res));
    const removed = new Promise<void>((res) => (onRemoved = res));
    events.on('event', (e: SandboxWsEvent) => {
      if (e.event === 'sandbox.status_changed' && e.status === 'running') onRunning();
      if (e.event === 'sandbox.removed' && e.sandboxId === sandboxId) onRemoved();
    });

    const created = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: 'prj-events-2', runtime: 'claude-code' })
      .expect(201);
    sandboxId = created.body.id as string;

    await Promise.race([
      running,
      new Promise((_r, rej) => setTimeout(() => rej(new Error('never ran')), 5000)),
    ]);

    await request(app.getHttpServer()).delete(`/api/sandboxes/${sandboxId}`).send({}).expect(204);
    await Promise.race([
      removed,
      new Promise((_r, rej) => setTimeout(() => rej(new Error('never saw removed')), 5000)),
    ]);
    events.disconnect();
  });
});
