import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { DATABASE } from '@platform/shared-kernel';
import {
  PLATFORM_AGENT_TMUX_SESSION,
  PROJECT_FACADE,
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
  WS_SCHEMA_HASH,
} from '@platform/contracts';
import type {
  ProcessSpec,
  ProcessStream,
  ProviderRegistry,
  SandboxHandle,
  SandboxProvider,
  SandboxProviderCapabilities,
  SandboxProviderContext,
  SandboxRuntimeStatus,
  SandboxWsEvent,
} from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { useEnv } from './_env';
import { setupWebsockets } from '../../src/bootstrap/websocket.setup';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  EchoProcessStream,
  FakeExecProcessStream,
  fakeProjectFacade,
  fakeWorkspace,
} from './_fakes';

/**
 * E2E-1-bootstrap / E2E-1-bootstrapNoTmux (25 §5.1) — 「启动时即执行」 really happens in
 * the provision workflow, BEFORE any WS connection exists (裁决 D-15 / 03 §4.3 ⑤).
 *
 * The whole point of these two cases is what they do NOT do: nobody opens a terminal.
 * Under the previous design that meant the instruction never ran at all — for a user
 * who closed the browser, and unavoidably for MCP `create_sandbox`, which has no
 * terminal to open.
 */
/** Long enough that the derived NAME is a truncation, so "not echoed" is testable. */
const PROMPT = '把 README 翻译成英文并同步给文档站\n仓库在 /srv/internal-billing 下';

const CAPS: SandboxProviderCapabilities = {
  spawnTty: true,
  volumeMount: true,
  updateResources: false,
  pauseResume: false,
  snapshot: false,
  watchEvents: false,
  headlessTask: false,
};

/** Records every exec the `starting` 段 runs, and can make `command -v tmux` miss. */
class RecordingProvider implements SandboxProvider {
  readonly capabilities = CAPS;
  readonly name = 'aio';
  readonly execs: string[][] = [];
  readonly ttySpawns: string[][] = [];
  destroyed = 0;
  /** models the sandbox's own tmux server: created by new-session, then findable. */
  private sessionAlive = false;
  constructor(private readonly hasTmux: boolean) {}

  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    return { provider: this.name, providerSandboxId: `fake-${ctx.sandboxId}` };
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {
    this.destroyed += 1;
  }
  async inspect(): Promise<SandboxRuntimeStatus> {
    return { lifecycleState: 'instance_running' };
  }
  async spawn(_h: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> {
    if (spec.tty) {
      this.ttySpawns.push(spec.cmd);
      return new EchoProcessStream();
    }
    this.execs.push(spec.cmd);
    const joined = spec.cmd.join(' ');
    if (/command -v tmux/.test(joined) && !this.hasTmux) return new FakeExecProcessStream('', 127);
    if (/has-session/.test(joined)) {
      return new FakeExecProcessStream('', this.sessionAlive ? 0 : 1);
    }
    if (/new-session/.test(joined)) this.sessionAlive = true;
    return new FakeExecProcessStream('codex 0.139.0', 0);
  }
}

let app: INestApplication;
let port: number;
let provider: RecordingProvider;
let restoreEnv: () => void;

async function boot(hasTmux: boolean): Promise<void> {
  // codex is preinstalled on the AIO default image (04 §3 ★1), so the install step is
  // a probe rather than a 12-minute npm run; these cases are about the SESSION.
  restoreEnv = useEnv({
    DATABASE_URL: ':memory:',
    SANDBOX_DEFAULT_IMAGE: 'ghcr.io/agent-infra/sandbox:latest',
    ACCESS_PASSCODE: undefined,
  });
  provider = new RecordingProvider(hasTmux);
  const registry: ProviderRegistry = {
    defaultProvider: 'aio',
    register: () => {},
    get: () => provider,
    has: (n) => n === 'aio',
    list: () => [provider],
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER_REGISTRY)
    .useValue(registry)
    .overrideProvider(WORKSPACE_PREPARER)
    .useValue(fakeWorkspace)
    .overrideProvider(PROJECT_FACADE)
    .useValue(fakeProjectFacade)
    .compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ZodValidationPipe());
  setupWebsockets(app);
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}

afterEach(async () => {
  await app?.close();
  restoreEnv?.();
});

function connectEvents(): Promise<Socket> {
  const sock = io(`http://127.0.0.1:${port}/events`, { transports: ['websocket'], forceNew: true });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 4000);
    sock.on('connect', () => {
      clearTimeout(t);
      resolve(sock);
    });
    sock.on('connect_error', reject);
  });
}

async function waitFor(id: string, status: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i++) {
    const res = await request(app.getHttpServer()).get(`/api/sandboxes/${id}`);
    if (res.body?.status === status) return res.body as Record<string, unknown>;
    if (res.body?.status === 'failed' && status !== 'failed') {
      throw new Error(`sandbox went to failed: ${JSON.stringify(res.body)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`sandbox ${id} never reached ${status}`);
}

/** Read straight from the DB — `initialPrompt` is deliberately absent from the DTO. */
function sandboxRow(id: string): Record<string, unknown> {
  const db = app.get<{ $client: { prepare(sql: string): { get(v: string): unknown } } }>(DATABASE, {
    strict: false,
  });
  return db.$client
    .prepare(
      'SELECT name, initial_prompt, initial_prompt_consumed_at, failure_code, failure_reason FROM sandboxes WHERE id = ?',
    )
    .get(id) as Record<string, unknown>;
}

describe('E2E-1-bootstrap — the agent session starts in provision, with no terminal open', () => {
  beforeEach(async () => {
    await boot(true);
  });

  it('an initialPrompt is started inside the sandbox and marked consumed', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: 'prj-b', runtime: 'codex', initialPrompt: PROMPT })
      .expect(201);
    const id = created.body.id as string;
    await waitFor(id, 'running');

    // ① tmux was probed live, then the platform session was started DETACHED, holding
    //    the codex start command carrying the instruction.
    expect(provider.execs.some((c) => c.join(' ') === 'sh -c command -v tmux')).toBe(true);
    const start = provider.execs.find((c) => c.includes('new-session'))!;
    expect(start.slice(0, 5)).toEqual([
      'tmux',
      'new-session',
      '-d',
      '-s',
      PLATFORM_AGENT_TMUX_SESSION,
    ]);
    expect(start[5]).toContain(PROMPT);
    expect(start[5]).toContain('danger-full-access'); // codex's inner sandbox is OFF

    // ② the instruction is persisted and now marked consumed — a restart must not replay it
    const row = sandboxRow(id);
    expect(row.initial_prompt).toBe(PROMPT);
    expect(row.initial_prompt_consumed_at).not.toBeNull();

    // ③ …and it is NOT echoed anywhere on the wire (裁决 D-14). Only the derived task
    //    NAME travels — the rest of the instruction (a repo path here, exactly the kind
    //    of thing `list_sandboxes` must not hand an upstream agent) never leaves.
    expect(JSON.stringify(created.body)).not.toContain(PROMPT);
    expect(JSON.stringify(created.body)).not.toContain('/srv/internal-billing');
    const fetched = await request(app.getHttpServer()).get(`/api/sandboxes/${id}`).expect(200);
    expect(JSON.stringify(fetched.body)).not.toContain('/srv/internal-billing');
    expect(created.body.name).toBe('把 README 翻译成英文并同步给文档…');
    expect(row.name).toBe('把 README 翻译成英文并同步给文档…');
  });

  it('emits WS runtime.install_progress while sandbox.status stays `starting` (T-3)', async () => {
    const events = await connectEvents();
    const received: SandboxWsEvent[] = [];
    events.on('event', (e: SandboxWsEvent) => received.push(e));

    const created = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: 'prj-b', runtime: 'codex' })
      .expect(201);
    await waitFor(created.body.id as string, 'running');
    await new Promise((r) => setTimeout(r, 50));
    events.close();

    const progress = received.filter((e) => e.event === 'runtime.install_progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toMatchObject({
      event: 'runtime.install_progress',
      sandboxId: created.body.id,
      runtime: 'codex',
      status: 'installed',
    });
    // …and it is NOT reported as a status change: throughout the install the sandbox
    // status is constant at `starting`, so folding progress into `sandbox.status_changed`
    // would emit "state changes" where no state changed (10 §3.1).
    const starting = received.filter(
      (e) => e.event === 'sandbox.status_changed' && e.status === 'starting',
    );
    expect(starting).toHaveLength(1);
  });

  it('with no instruction a session still starts, from buildAttachCommand', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: 'prj-b', runtime: 'codex' })
      .expect(201);
    await waitFor(created.body.id as string, 'running');

    const start = provider.execs.find((c) => c.includes('new-session'))!;
    expect(start[5]).toContain('codex');
    expect(sandboxRow(created.body.id as string).initial_prompt_consumed_at).toBeNull();
  });
});

describe('E2E-1-bootstrapNoTmux — a missing tmux fails LOUDLY, it never degrades', () => {
  beforeEach(async () => {
    await boot(false);
  });

  it('lands failed with IMAGE_CONTRACT_VIOLATION, starts nothing, consumes nothing', async () => {
    const events = await connectEvents();
    const received: SandboxWsEvent[] = [];
    const sawFailed = new Promise<void>((resolve) => {
      events.on('event', (e: SandboxWsEvent) => {
        received.push(e);
        if (e.event === 'sandbox.status_changed' && e.status === 'failed') resolve();
      });
    });

    const created = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: 'prj-b', runtime: 'codex', initialPrompt: '重构登录模块' })
      .expect(201);
    const id = created.body.id as string;

    await Promise.race([
      sawFailed,
      new Promise((_r, rej) => setTimeout(() => rej(new Error('never saw failed')), 8000)),
    ]);
    events.close();

    // ① the DB carries the CODE as its own column, so a page reload still explains
    //    the failure (the WS event below is live-only and cannot be replayed).
    const row = sandboxRow(id);
    expect(row.failure_code).toBe('IMAGE_CONTRACT_VIOLATION');
    expect(String(row.failure_reason)).toContain('tmux');
    // …and the REST read-back exposes both halves (the refresh path, 10 §7.3).
    const dto = await request(app.getHttpServer()).get(`/api/sandboxes/${id}`).expect(200);
    expect(dto.body.failureCode).toBe('IMAGE_CONTRACT_VIOLATION');
    expect(dto.body.failureMessage).toContain('tmux');

    // ② the WS stream carries the SAME code — this is the ONLY live channel for it
    //    (unlike INSTALL_FAILED, which also rides runtime.install_progress), so
    //    without it the frontend could only show generic fallback copy.
    const failedEvent = received.find(
      (e) => e.event === 'sandbox.status_changed' && e.status === 'failed',
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent).toMatchObject({ errorCode: 'IMAGE_CONTRACT_VIOLATION' });

    // ③ NOTHING was started, and the instruction was NOT consumed — a session that
    //    never started has not executed the task (I-SBX-10)
    expect(provider.execs.some((c) => c.includes('new-session'))).toBe(false);
    expect(row.initial_prompt).toBe('重构登录模块');
    expect(row.initial_prompt_consumed_at).toBeNull();

    // ④ the standard `starting` compensation ran (24 §1.3)
    expect(provider.destroyed).toBeGreaterThan(0);
  });
});

describe('E2E-8-attachOnly — the terminal gateway attaches, it never starts the task', () => {
  beforeEach(async () => {
    await boot(true);
  });

  it('the first WS terminal runs `tmux attach`, and buildStartCommand is NOT re-run', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: 'prj-b', runtime: 'codex', initialPrompt: PROMPT })
      .expect(201);
    const id = created.body.id as string;
    await waitFor(id, 'running');

    const startsBefore = provider.execs.filter((c) => c.includes('new-session')).length;
    expect(startsBefore).toBe(1); // provision started exactly one session
    const execsBefore = provider.execs.length;

    const term = await connectTerminal(id);
    await new Promise((r) => setTimeout(r, 100));
    term.close();

    // the pty joined the EXISTING platform session…
    expect(provider.ttySpawns[0]).toEqual(['tmux', 'attach', '-t', PLATFORM_AGENT_TMUX_SESSION]);
    // …and the gateway did not start a second one, nor re-issue the instruction
    // (that decision moved into provision — 26 §8 / 裁决 D-15).
    const afterConnect = provider.execs.slice(execsBefore);
    expect(afterConnect.some((c) => c.includes('new-session'))).toBe(false);
    expect(afterConnect.some((c) => c.join(' ').includes(PROMPT))).toBe(false);
  });
});

function connectTerminal(sandboxId: string): Promise<Socket> {
  const sock = io(`http://127.0.0.1:${port}/terminal`, {
    // `xSchemaHash` is REQUIRED on `/terminal`, exactly as it is on `/tasks`: a
    // handshake without it is refused, so a test client presents it like the real one.
    query: { sandboxId, cols: '80', rows: '24', xSchemaHash: WS_SCHEMA_HASH },
    transports: ['websocket'],
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('terminal connect timeout')), 4000);
    sock.on('connect', () => {
      clearTimeout(t);
      resolve(sock);
    });
    sock.on('connect_error', reject);
  });
}
