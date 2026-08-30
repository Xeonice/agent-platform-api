import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import {
  PROJECT_FACADE,
  IMAGE_SPEC_REGISTRY,
  SANDBOX_PROVIDER_REGISTRY,
  WORKSPACE_PREPARER,
} from '@platform/contracts';
import type { ProcessSpec, ProcessStream, SandboxDto, SandboxHandle } from '@platform/contracts';
import { SandboxMcpTools } from '@platform/sandbox';
import { AppModule } from '../../src/app.module';
import { useEnv } from './_env';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import {
  EchoProcessStream,
  FakeExecProcessStream,
  FakeProvider,
  makeFakeImageSpecRegistry,
  registerDefaultImage,
  fakeProjectFacade,
  fakeWorkspace,
  makeFakeRegistry,
} from './_fakes';

/**
 * The INTERFACE leg of `POST /api/sandboxes/:id/{start,stop,exec}` and the four MCP
 * tools that wrap them (27 §2 / 02 §5.2) — on in-memory doubles, so the whole surface
 * is proven without a docker daemon.
 *
 * ── Why an e2e on top of the application-layer suite ─────────────────────────────
 * `lifecycle.spec.ts` proves the BEHAVIOUR. What only this file can see is the part
 * that lives in the shells and the global pipeline:
 *   ① the routes exist at the paths the frontend's generated client will call;
 *   ② a refusal comes back as a real `ErrorEnvelope` through `ErrorEnvelopeFilter`,
 *      not as Nest's `{statusCode, message, error}` — the frontend's `toApiError`
 *      discards the latter and shows 「请求失败（HTTP 409）」 instead of the sentence
 *      the platform wrote (10 §6.8 ★);
 *   ③ the MCP tools are REGISTERED on the same application service, which is the whole
 *      claim of 02 §1 「一个能力 = 两层薄壳」.
 */
/**
 * A provider whose exec ECHOES BACK the argv it was given.
 *
 * ⚠️ THE SHARED `FakeProvider` ANSWERS EVERY EXEC WITH THE SAME CANNED STRING, which
 * makes 「the command reached the sandbox」 unobservable: a controller that ignored the
 * request body and ran a hard-coded command would produce byte-identical responses.
 * Measured — that mutation passed all seven tests before this class existed.
 */
class EchoingExecProvider extends FakeProvider {
  override async spawn(_h: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> {
    if (spec.tty) return new EchoProcessStream();
    return new FakeExecProcessStream(JSON.stringify(spec.cmd), 0);
  }
}

let app: INestApplication;
let restoreEnv: () => void;

const PROJECT = 'prj-lifecycle';
const RUNTIME = 'claude-code';

beforeAll(async () => {
  restoreEnv = useEnv({ DATABASE_URL: ':memory:', ACCESS_PASSCODE: undefined });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SANDBOX_PROVIDER_REGISTRY)
    .useValue(makeFakeRegistry([new EchoingExecProvider('aio')]))
    .overrideProvider(WORKSPACE_PREPARER)
    .useValue(fakeWorkspace)
    .overrideProvider(PROJECT_FACADE)
    .useValue(fakeProjectFacade)
    .overrideProvider(IMAGE_SPEC_REGISTRY)
    .useValue(makeFakeImageSpecRegistry())
    .compile();
  app = moduleRef.createNestApplication();
  configurePlatformApp(app);
  await app.init();
  // ONE port for the whole file (suite-hygiene): without it supertest rebinds an
  // ephemeral port per request, and in this shared single-fork process a race can
  // deliver the request to a different app's server.
  await app.listen(0);
  await registerDefaultImage(app);
});

afterAll(async () => {
  await app?.close();
  restoreEnv?.();
});

const http = () => request(app.getHttpServer());

async function waitForStatus(id: string, status: string): Promise<SandboxDto> {
  for (let i = 0; i < 400; i++) {
    const res = await http().get(`/api/sandboxes/${id}`).expect(200);
    if (res.body.status === status) return res.body as SandboxDto;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`sandbox ${id} never reached ${status}`);
}

async function runningSandbox(): Promise<string> {
  const created = await http()
    .post('/api/sandboxes')
    .send({ projectId: PROJECT, runtime: RUNTIME })
    .expect(201);
  const id = String(created.body.id);
  await waitForStatus(id, 'running');
  return id;
}

describe('the stop → start round trip over REST', () => {
  it('stops, then starts again, and the id/workspace survive both', async () => {
    const id = await runningSandbox();

    const stopped = await http().post(`/api/sandboxes/${id}/stop`).expect(200);
    expect(stopped.body.status).toBe('stopped');
    expect(stopped.body.id).toBe(id);

    const started = await http().post(`/api/sandboxes/${id}/start`).expect(200);
    // 「已受理」, not 「已就绪」 — the 段 behind it is minutes long on a cold image store.
    expect(started.body.status).toBe('starting');
    await waitForStatus(id, 'running');
  });

  it('refuses a second stop with a complete ErrorEnvelope, not a bare Nest body', async () => {
    const id = await runningSandbox();
    await http().post(`/api/sandboxes/${id}/stop`).expect(200);

    const res = await http().post(`/api/sandboxes/${id}/stop`).expect(409);

    // ⚠️ ALL FOUR FIELDS. `toApiError` needs `code` AND `retryable` before it treats a
    // body as an envelope at all; without them the user sees 「请求失败（HTTP 409）」 and
    // the sentence naming the actual state is thrown away (10 §6.8 ★).
    expect(res.body).toMatchObject({ code: 'INVALID_STATE', retryable: false });
    expect(typeof res.body.message).toBe('string');
    expect(typeof res.body.traceId).toBe('string');
  });

  it('404s an unknown id on all three routes, as an envelope', async () => {
    for (const path of ['start', 'stop', 'exec']) {
      const res = await http()
        .post(`/api/sandboxes/sbx-nope/${path}`)
        .send({ command: 'true' })
        .expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND', retryable: false });
    }
  });
});

describe('POST /api/sandboxes/:id/exec over REST', () => {
  it('returns {stdout, stderr, exitCode} for a command in a running sandbox', async () => {
    const id = await runningSandbox();

    const res = await http()
      .post(`/api/sandboxes/${id}/exec`)
      .send({ command: 'echo hi && echo there' })
      .expect(200);

    expect(res.body).toEqual({ stdout: expect.any(String), stderr: '', exitCode: 0 });
    // ⚠️ AND THE COMMAND FROM THE BODY IS WHAT RAN, unsplit. Without this the endpoint
    // could ignore `@Body()` entirely and still answer 200 with a plausible shape.
    expect(JSON.parse(res.body.stdout)).toEqual(['sh', '-c', 'echo hi && echo there']);
  });

  it('rejects an empty command with a VALIDATION_FAILED envelope (04 §4.2)', async () => {
    const id = await runningSandbox();
    const res = await http().post(`/api/sandboxes/${id}/exec`).send({ command: '' }).expect(400);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: false,
      sideEffectFree: true,
    });
  });
});

describe('the four MCP tools wrap the SAME application service (02 §1)', () => {
  it('get_sandbox / stop_sandbox / start_sandbox / exec_in_sandbox are all registered', async () => {
    const tools = app.get(SandboxMcpTools);
    const id = await runningSandbox();

    const read = JSON.parse((await tools.getSandbox({ id })).content[0].text) as SandboxDto;
    expect(read.id).toBe(id);
    expect(read.status).toBe('running');

    const stopped = JSON.parse((await tools.stopSandbox({ id })).content[0].text) as SandboxDto;
    expect(stopped.status).toBe('stopped');

    const started = JSON.parse((await tools.startSandbox({ id })).content[0].text) as SandboxDto;
    expect(started.status).toBe('starting');
    await waitForStatus(id, 'running');

    const exec = JSON.parse(
      (await tools.execInSandbox({ id, command: 'echo hi' })).content[0].text,
    );
    expect(exec).toMatchObject({ stderr: '', exitCode: 0 });
    expect(JSON.parse(exec.stdout)).toEqual(['sh', '-c', 'echo hi']);
  });

  it('a tool refusal carries the same HTTP-shaped error the REST shell produces', async () => {
    const tools = app.get(SandboxMcpTools);
    const id = await runningSandbox();
    await tools.stopSandbox({ id });

    // ⚠️ ONE application service means ONE set of rules. A tool that skipped the state
    // check would give an LLM caller a capability the REST caller does not have — which
    // is the exact drift 02 §1's 「两层薄壳」 exists to prevent.
    await expect(tools.execInSandbox({ id, command: 'true' })).rejects.toMatchObject({
      response: { code: 'INVALID_STATE' },
    });
    await expect(tools.stopSandbox({ id })).rejects.toMatchObject({
      response: { code: 'INVALID_STATE' },
    });
  });
});
