import { mkdtempSync, rmSync } from 'node:fs';
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

/**
 * FULL-CHAIN docker-required e2e (S1 acceptance), PARAMETERIZED over BOTH built-in
 * providers: for `aio` AND `boxlite` it runs REST POST /api/sandboxes → real
 * ProviderRegistry → the matching provider CLASS → real docker container →
 * socket.io /terminal → real container PTY (`/bin/sh`) → `ls /` → asserts real
 * root dirs → DELETE. It also proves the registry selected the RIGHT provider by
 * asserting the container's `platform.provider` / `platform.isolation` labels
 * (aio=container, boxlite=micro-vm) and that the two providers' capabilities
 * genuinely differ — so this is not "aio run twice".
 *
 * Skips loudly when the docker daemon is unreachable (never fake-passes).
 */
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? 'alpine:3.20';
const dockerUp = await isDockerAvailable(createDockerClient()).catch(() => false);

if (!dockerUp) {
  console.warn(
    '\n[33m========================================================================\n' +
      '[terminal-container.e2e] SKIPPED — docker daemon unreachable.\n' +
      'This is the full REST→WS→real-container-PTY chain; run it with docker up.\n' +
      '========================================================================[0m\n',
  );
}

const PROVIDERS = [
  { provider: 'aio', isolation: 'container', updateResources: true, pauseResume: true },
  { provider: 'boxlite', isolation: 'micro-vm', updateResources: false, pauseResume: false },
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
        expect(created.body.status).toBe('running');

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
        try {
          const session = await nextFrame(sock, (f) => f.type === 'session');
          if (session.type === 'session') {
            expect(session.socketSessionKey).toMatch(/^[0-9a-f]{32}$/); // 128-bit, server-generated
          }
          sock.emit('frame', { type: 'input', data: 'ls /\n' });
          const out = await waitForOutput(sock, /\b(bin|etc|usr)\b/);
          expect(out).toMatch(/\b(bin|etc|usr)\b/);
        } finally {
          sock.disconnect();
        }

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
