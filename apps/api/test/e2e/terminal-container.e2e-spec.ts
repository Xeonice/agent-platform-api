import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { SANDBOX_PROVIDER_REGISTRY, WS_SCHEMA_HASH } from '@platform/contracts';
import type { ProviderRegistry, TerminalServerFrame } from '@platform/contracts';
import { IMAGE_SPEC_REGISTRY } from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { makeFakeImageSpecRegistry, registerDefaultImage } from './_fakes';
import { setupWebsockets } from '../../src/bootstrap/websocket.setup';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
import {
  createDockerClient,
  isDockerAvailable,
} from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-client';
import { AioSandboxProvider } from '../../../../packages/modules/sandbox/src/infrastructure/providers/aio/aio-sandbox.provider';
import { SANDBOX_REPOSITORY } from '../../../../packages/modules/sandbox/src/domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../../../../packages/modules/sandbox/src/domain/repositories/sandbox.repository';
import { asSandboxId } from '@platform/shared-kernel';
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
// The AIO Sandbox image is ~3.3GB; do NOT auto-pull it (esp. on CI). Skip loud
// unless it is already present locally (set SANDBOX_TEST_IMAGE to override).
const imagePresent = dockerUp
  ? await createDockerClient()
      .getImage(IMAGE)
      .inspect()
      .then(() => true)
      .catch(() => false)
  : false;
const runnable = dockerUp && imagePresent;

if (!runnable) {
  console.warn(
    '\n[33m========================================================================\n' +
      '[terminal-container.e2e] SKIPPED — docker down or AIO image not present locally.\n' +
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
  if (!runnable) return;
  process.env.DATABASE_URL = ':memory:';
  // project-local temp dir so the host path is docker-shareable (macOS Docker Desktop)
  dataRoot = mkdtempSync(resolve(process.cwd(), 'tmp-e2e-data-'));
  process.env.DATA_ROOT = dataRoot;
  process.env.SANDBOX_DEFAULT_IMAGE = IMAGE;

  // REAL providers + registry + workspace preparer (no overrides).
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // Only the registry round-trip is doubled — the rest of the image chain
    // (register → freeze digest → door lookup → FK → pull `ref@digest`) is real.
    .overrideProvider(IMAGE_SPEC_REGISTRY)
    .useValue(makeFakeImageSpecRegistry())
    .compile();
  app = moduleRef.createNestApplication();
  configurePlatformApp(app);
  setupWebsockets(app);
  await app.init();
  await app.listen(0);
  // 04 §7 时刻③: the create door only accepts a REGISTERED image now.
  await registerDefaultImage(app);
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

describe.skipIf(!runnable)(
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
        // 0) create a real (empty) project — the sandbox create now validates it.
        const projectRes = await request(app.getHttpServer())
          .post('/api/projects')
          .send({ name: `proj-${provider}`, sourceType: 'empty' })
          .expect(202);
        const projectId = projectRes.body.id as string;
        expect(projectRes.body.cloneStatus).toBe('ready');

        // 1) create via REST — registry must route to the `provider` class
        const created = await request(app.getHttpServer())
          .post('/api/sandboxes')
          .send({ projectId, runtime: 'claude-code', provider })
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
        // 加固 2: the workspace stays 0777 (the non-root in-sandbox user must write
        // it) but its PARENT is 0700, so no other local user can traverse in and
        // read the cloned repo — or plant an AGENTS.md for the next agent run.
        expect(statSync(resolve(dataRoot, 'workspaces')).mode & 0o777).toBe(0o700);
        expect(statSync(wsDir).mode & 0o777).toBe(0o777);
        try {
          const session = await nextFrame(sock, (f) => f.type === 'session');
          if (session.type === 'session') {
            expect(session.socketSessionKey).toMatch(/^[0-9a-f]{32}$/); // 128-bit, server-generated
          }
          // S5 (裁决 D-15 / 26 §8): the gateway ATTACHES the tmux session provision
          // already started, and that session is running the AGENT CLI — not a shell.
          // Wait for the agent's own banner: it proves the whole S5 chain end to end
          // (CLI verified present → tmux session started detached by provision → the
          // gateway attached it), and it proves `ProcessSpec.cmd` now reaches the tty
          // side at all, which it did not before (04 §2.3★「仍然存在的限制」).
          // NB the tolerant separator: the banner arrives as a tmux-redrawn frame where
          // every word is separated by cursor-movement escapes, and `stripAnsi` here
          // removes the CSI bodies but leaves the bare ESC bytes behind — `\s*` would
          // not match those, which is exactly the kind of intermittent
          // "assertion passes on one render and not the next" this comment exists to
          // stop someone re-introducing.
          await waitForOutput(sock, /Claude[^\w]{0,16}Code/i, 20000);

          // The workspace round-trip now goes over the one-shot EXEC data plane rather
          // than by typing into the terminal: since S5 the terminal is the AGENT's
          // (a full-screen TUI that owns the keyboard), so driving shell commands
          // through it would be testing the agent's input handling, not ours. The
          // exec path is the same in-sandbox agent and the same bind mount.
          const shell = async (script: string): Promise<string> =>
            collectStream(
              await app
                .get<ProviderRegistry>(SANDBOX_PROVIDER_REGISTRY)
                .get(provider)
                .spawn(
                  {
                    provider,
                    providerSandboxId: (await docker.getContainer(containerName).inspect()).Id,
                    agentAuthToken:
                      (
                        await app
                          .get<SandboxRepository>(SANDBOX_REPOSITORY)
                          .findById(asSandboxId(sandboxId))
                      )?.agentAuthToken ?? undefined,
                  },
                  { tty: false, cmd: ['sh', '-c', script] },
                ),
            );

          expect(await shell('ls /')).toMatch(/\b(bin|etc|usr)\b/);

          // The platform's tmux session is REALLY alive inside the sandbox, held by the
          // sandbox's own tmux server — which is why a backend restart cannot end it.
          // `has-session` + echo puts the verdict on STDOUT: `tmux ls` answers on
          // stderr, which `toExecFn` does not carry (04 §2.4).
          expect(await shell('tmux has-session -t platform-agent; echo rc=$?')).toContain('rc=0');

          // workspace bind-mount is REALLY usable by the non-root agent user (the
          // WorkspacePreparer 0777 fix). host → box: seed a file, read it in-sandbox.
          writeFileSync(resolve(wsDir, 'host-seed.txt'), 'HOST_SEED_AIO\n');
          expect(await shell('cat /workspace/host-seed.txt')).toContain('HOST_SEED_AIO');
          // box → host: the sandbox writes /workspace, the host sees it.
          await shell('echo BOX_WROTE_AIO > /workspace/box-out.txt');
          await waitForFileContains(resolve(wsDir, 'box-out.txt'), 'BOX_WROTE_AIO');
        } finally {
          sock.disconnect();
        }

        // aio restart-safety (parity with boxlite): a FRESH provider instance
        // re-derives the agent port from `docker inspect` (no persisted state) and
        // reconnects — so exec/terminal survive a backend restart.
        const cid = (await docker.getContainer(containerName).inspect()).Id;
        // …but the agent BEARER TOKEN is the one thing docker cannot give back (the
        // container only carries the public half), so the restart path reads it out
        // of the DB, exactly like SandboxPtyAdapter does on a real reconnect.
        const repo = app.get<SandboxRepository>(SANDBOX_REPOSITORY);
        const persistedSandbox = await repo.findById(asSandboxId(sandboxId));
        const agentAuthToken = persistedSandbox?.agentAuthToken ?? undefined;
        expect(agentAuthToken).toBeTypeOf('string');
        const freshAio = new AioSandboxProvider(createDockerClient());
        const exec = await freshAio.spawn(
          { provider: 'aio', providerSandboxId: cid, agentAuthToken },
          { tty: false, cmd: ['echo', 'AIO_RESTART_OK'] },
        );
        expect(await collectStream(exec)).toContain('AIO_RESTART_OK');

        // …and the token is LOAD-BEARING, not decoration: the same call without it
        // is refused by the agent itself (加固 1 — the loopback port is no longer
        // an open shell for anything else running on this host).
        const anonymous = await freshAio.spawn(
          { provider: 'aio', providerSandboxId: cid },
          { tty: false, cmd: ['echo', 'SHOULD_NOT_RUN'] },
        );
        const anonymousOut = await collectStream(anonymous).catch((e: Error) => e.message);
        expect(anonymousOut).not.toContain('SHOULD_NOT_RUN');

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
