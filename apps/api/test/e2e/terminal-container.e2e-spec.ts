import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { io, type Socket } from 'socket.io-client';
import { SANDBOX_PROVIDER_REGISTRY, WS_SCHEMA_HASH } from '@platform/contracts';
import type { ProviderRegistry, TerminalServerFrame } from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { setupWebsockets } from '../../src/bootstrap/websocket.setup';
import {
  createDockerClient,
  isDockerAvailable,
} from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-client';
import { AioSandboxProvider } from '../../../../packages/modules/sandbox/src/infrastructure/providers/aio/aio-sandbox.provider';
import type { ProcessStream } from '@platform/contracts';

/**
 * FULL-CHAIN docker-required e2e for the `aio` provider (ADR 决策 A): REST POST
 * /api/sandboxes → real ProviderRegistry → AioSandboxProvider → real docker
 * container running the AIO Sandbox image → socket.io /terminal → the REAL
 * in-sandbox agent PTY via `ws /v1/shell/ws` (NOT host docker exec) → `ls /` →
 * asserts real root dirs → DELETE. It also asserts the container's
 * `platform.provider`/`platform.isolation` labels and that the registry exposes
 * two DISTINCT providers with divergent capabilities (so `boxlite` is a real
 * second class, not a label). The `boxlite` micro-VM chain is covered separately
 * by boxlite-microvm.e2e (决策 B, BoxLite SDK — no docker container).
 *
 * Skips loudly when the docker daemon is unreachable (never fake-passes). Requires
 * the AIO Sandbox image present locally (SANDBOX_TEST_IMAGE to override).
 */
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? 'ghcr.io/agent-infra/sandbox:latest';
const dockerUp = await isDockerAvailable(createDockerClient()).catch(() => false);

if (!dockerUp) {
  console.warn(
    '\n[33m========================================================================\n' +
      '[terminal-container.e2e] SKIPPED — docker daemon unreachable.\n' +
      'This is the full REST→WS→real-container-PTY chain; run it with docker up.\n' +
      '========================================================================[0m\n',
  );
}

// aio only here — boxlite runs on the BoxLite micro-VM SDK (no docker container),
// exercised by boxlite-microvm.e2e.
const PROVIDERS = [
  { provider: 'aio', isolation: 'container', updateResources: true, pauseResume: true },
] as const;

let app: INestApplication;
let port: number;
let dataRoot: string;
const docker = createDockerClient();
/** container names created during the run, force-removed in afterAll. */
const createdContainers = new Set<string>();

beforeAll(async () => {
  if (!dockerUp) return;
  process.env.DATABASE_URL = ':memory:';
  // project-local temp dir so the host path is docker-shareable (macOS Docker Desktop)
  dataRoot = mkdtempSync(resolve(process.cwd(), 'tmp-e2e-data-'));
  process.env.DATA_ROOT = dataRoot;
  process.env.SANDBOX_DEFAULT_IMAGE = IMAGE;

  // REAL providers + registry + workspace preparer (no overrides).
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ZodValidationPipe());
  setupWebsockets(app);
  await app.init();
  await app.listen(0);
  const addr = app.getHttpServer().address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 60_000);

afterAll(async () => {
  for (const name of createdContainers) {
    await docker
      .getContainer(name)
      .remove({ force: true })
      .catch(() => undefined);
  }
  await app?.close();
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

function nextFrame(
  sock: Socket,
  pred: (f: TerminalServerFrame) => boolean,
  ms = 8000,
): Promise<TerminalServerFrame> {
  return new Promise((resolveP, reject) => {
    const t = setTimeout(() => reject(new Error('frame timeout')), ms);
    const h = (f: TerminalServerFrame) => {
      if (pred(f)) {
        clearTimeout(t);
        sock.off('frame', h);
        resolveP(f);
      }
    };
    sock.on('frame', h);
  });
}

/** Strip ANSI escape sequences so plain dir names aren't glued to color codes. */
function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;?]*[A-Za-z]/g, '');
}

/** Poll REST until the async-provisioned sandbox reaches `running` (P1-#1). */
async function waitForRunning(app: INestApplication, id: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  let status = 'pending';
  while (Date.now() < deadline) {
    const got = await request(app.getHttpServer()).get(`/api/sandboxes/${id}`);
    status = got.body?.status;
    if (status === 'running') return;
    if (status === 'failed') throw new Error(`sandbox ${id} failed: ${JSON.stringify(got.body)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`sandbox ${id} never reached running (last=${status})`);
}

/** Collect a one-shot exec ProcessStream's output to EOF. */
function collectStream(stream: ProcessStream): Promise<string> {
  return new Promise((res) => {
    let out = '';
    stream.onData((c) => {
      out += c.toString('utf8');
    });
    stream.onExit(() => res(out));
  });
}

/** Poll a host file until it contains `needle` (proves box→host workspace writes). */
async function waitForFileContains(path: string, needle: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, 'utf8').includes(needle)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`host file ${path} never contained ${needle}`);
}

/** Resolve once accumulated (ANSI-stripped) `data` frames match `re`. */
function waitForOutput(sock: Socket, re: RegExp, ms = 12000): Promise<string> {
  return new Promise((resolveP, reject) => {
    let acc = '';
    const t = setTimeout(
      () => reject(new Error(`output timeout; got: ${JSON.stringify(acc)}`)),
      ms,
    );
    const h = (f: TerminalServerFrame) => {
      if (f.type === 'data') {
        acc += f.data;
        if (re.test(stripAnsi(acc))) {
          clearTimeout(t);
          sock.off('frame', h);
          resolveP(stripAnsi(acc));
        }
      }
    };
    sock.on('frame', h);
  });
}

describe.skipIf(!dockerUp)(
  'full chain: REST → socket.io → real container PTY (per provider)',
  () => {
    it('the registry exposes two DISTINCT providers with different capabilities', () => {
      const registry = app.get<ProviderRegistry>(SANDBOX_PROVIDER_REGISTRY);
      expect(registry.defaultProvider).toBe('aio');
      const aio = registry.get('aio');
      const boxlite = registry.get('boxlite');
      expect(aio).not.toBe(boxlite);
      expect(aio.name).toBe('aio');
      expect(boxlite.name).toBe('boxlite');
      // capability divergence proves these are two different classes, not aio twice
      expect(aio.capabilities.updateResources).toBe(true);
      expect(aio.capabilities.pauseResume).toBe(true);
      expect(boxlite.capabilities.updateResources).toBe(false);
      expect(boxlite.capabilities.pauseResume).toBe(false);
    });

    it.each(PROVIDERS)(
      'provider=$provider: real container ($isolation) → ls / → destroy',
      async ({ provider, isolation, updateResources, pauseResume }) => {
        // 1) create via REST — registry must route to the `provider` class
        const created = await request(app.getHttpServer())
          .post('/api/sandboxes')
          .send({ projectId: `prj-${provider}-e2e`, runtime: 'claude-code', provider })
          .expect(201);
        const sandboxId = created.body.id as string;
        const containerName = `platform-${provider}-${sandboxId}`;
        createdContainers.add(containerName);
        // ASYNC create (P1-#1): POST returns `pending`; wait for background provision.
        expect(created.body.status).toBe('pending');
        await waitForRunning(app, sandboxId);

        // 2) PROVE the right provider class was selected: inspect the real container's labels
        const info = await docker.getContainer(containerName).inspect();
        expect(info.Config.Labels['platform.provider']).toBe(provider);
        expect(info.Config.Labels['platform.isolation']).toBe(isolation);
        // sanity: capability flags for this provider match what the registry advertises
        const advertised = app.get<ProviderRegistry>(SANDBOX_PROVIDER_REGISTRY).get(provider);
        expect(advertised.capabilities.updateResources).toBe(updateResources);
        expect(advertised.capabilities.pauseResume).toBe(pauseResume);

        // 3) open the terminal over socket.io and run `ls /` in the REAL container
        const sock = io(`http://127.0.0.1:${port}/terminal`, {
          query: { sandboxId, xSchemaHash: WS_SCHEMA_HASH },
          transports: ['websocket'],
          forceNew: true,
        });
        const wsDir = resolve(dataRoot, 'workspaces', sandboxId);
        try {
          const session = await nextFrame(sock, (f) => f.type === 'session');
          if (session.type === 'session') {
            expect(session.socketSessionKey).toMatch(/^[0-9a-f]{32}$/); // 128-bit, server-generated
          }
          sock.emit('frame', { type: 'input', data: 'ls /\n' });
          const out = await waitForOutput(sock, /\b(bin|etc|usr)\b/);
          expect(out).toMatch(/\b(bin|etc|usr)\b/);

          // workspace bind-mount is REALLY usable by the non-root agent user (the
          // WorkspacePreparer 0777 fix). host → box: seed a file, read it in-sandbox.
          writeFileSync(resolve(wsDir, 'host-seed.txt'), 'HOST_SEED_AIO\n');
          sock.emit('frame', { type: 'input', data: 'cat /workspace/host-seed.txt\n' });
          await waitForOutput(sock, /HOST_SEED_AIO/);
          // box → host: the sandbox writes /workspace, the host sees it.
          sock.emit('frame', { type: 'input', data: 'echo BOX_WROTE_AIO > /workspace/box-out.txt\n' });
          await waitForFileContains(resolve(wsDir, 'box-out.txt'), 'BOX_WROTE_AIO');
        } finally {
          sock.disconnect();
        }

        // aio restart-safety (parity with boxlite): a FRESH provider instance
        // re-derives the agent port from `docker inspect` (no persisted state) and
        // reconnects — so exec/terminal survive a backend restart.
        const cid = (await docker.getContainer(containerName).inspect()).Id;
        const freshAio = new AioSandboxProvider(createDockerClient());
        const exec = await freshAio.spawn(
          { provider: 'aio', providerSandboxId: cid },
          { tty: false, cmd: ['echo', 'AIO_RESTART_OK'] },
        );
        expect(await collectStream(exec)).toContain('AIO_RESTART_OK');

        // 4) destroy via REST + assert the container is really gone
        await request(app.getHttpServer())
          .delete(`/api/sandboxes/${sandboxId}`)
          .send({})
          .expect(204);
        const gone = await docker
          .getContainer(containerName)
          .inspect()
          .then(() => true)
          .catch(() => false);
        expect(gone).toBe(false);
        createdContainers.delete(containerName);
      },
      60_000,
    );
  },
);
