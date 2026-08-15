import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { io, type Socket } from 'socket.io-client';
import { WS_SCHEMA_HASH } from '@platform/contracts';
import type { TerminalServerFrame } from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { setupWebsockets } from '../../src/bootstrap/websocket.setup';

/**
 * BOXLITE-REQUIRED e2e (SANDBOX-RUNTIME-DECISIONS 决策 B). Full chain for the REAL
 * BoxLite micro-VM control plane: REST POST /api/sandboxes (provider=boxlite) →
 * ProviderRegistry → BoxliteSandboxProvider → BoxLite SDK starts an independent-
 * kernel Box from the LOCAL registry image → forwarded host `:8080` →
 * socket.io /terminal → the in-sandbox AIO agent PTY via `ws /v1/shell/ws` →
 * `ls /` → asserts real root dirs → DELETE.
 *
 * Skips LOUDLY (never fake-passes) when either prerequisite is missing:
 *   - the BoxLite native binary (darwin-arm64 / Hypervisor.framework), or
 *   - the local registry at :5001 serving the staged AIO image.
 * First Box boot + image pull is slow — timeouts are generous.
 */
const REGISTRY = process.env.SANDBOX_BOXLITE_REGISTRY ?? 'localhost:5001';
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? `${REGISTRY}/agent-infra/sandbox:latest`;

// Resolve the SDK the SAME way the provider does — from the @platform/sandbox
// package, where `@boxlite-ai/boxlite` is a dependency (it is NOT a dep of
// apps/api, so a bare import here would spuriously report "missing"). Actually
// loading it exercises the native addon, so this fails loud on Linux/missing binary.
function boxliteBinaryPresent(): boolean {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const sandboxPkg = resolve(here, '../../../../packages/modules/sandbox/package.json');
    const requireFromSandbox = createRequire(sandboxPkg);
    requireFromSandbox('@boxlite-ai/boxlite');
    return true;
  } catch {
    return false;
  }
}

async function registryServingImage(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`http://${REGISTRY}/v2/agent-infra/sandbox/tags/list`, {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return false;
    const body = (await res.json()) as { tags?: string[] };
    return Array.isArray(body.tags) && body.tags.includes('latest');
  } catch {
    return false;
  }
}

const boxliteReady = boxliteBinaryPresent();
const registryReady = await registryServingImage();
const ready = boxliteReady && registryReady;

if (!ready) {
  console.warn(
    '\n[33m========================================================================\n' +
      '[boxlite-microvm.e2e] SKIPPED — BoxLite micro-VM prerequisites missing:\n' +
      `  - BoxLite native binary present: ${boxliteReady}\n` +
      `  - local registry ${REGISTRY} serving agent-infra/sandbox:latest: ${registryReady}\n` +
      'This is the real BoxLite Box → forwarded :8080 → /v1/shell/ws chain (决策 B).\n' +
      'Bring up the :5001 registry (with the staged AIO arm64 image) on an Apple\n' +
      'Silicon host to run it. NOT fake-passed.\n' +
      '========================================================================[0m\n',
  );
}

let app: INestApplication;
let port: number;
let dataRoot: string;

beforeAll(async () => {
  if (!ready) return;
  process.env.DATABASE_URL = ':memory:';
  dataRoot = mkdtempSync(resolve(process.cwd(), 'tmp-boxlite-e2e-'));
  process.env.DATA_ROOT = dataRoot;
  process.env.SANDBOX_DEFAULT_IMAGE = IMAGE;

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
  await app?.close();
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

function nextFrame(
  sock: Socket,
  pred: (f: TerminalServerFrame) => boolean,
  ms = 15000,
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

function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;?]*[A-Za-z]/g, '');
}

async function waitForFileContains(path: string, needle: string, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, 'utf8').includes(needle)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`host file ${path} never contained ${needle}`);
}

function waitForOutput(sock: Socket, re: RegExp, ms = 20000): Promise<string> {
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

describe.skipIf(!ready)('boxlite micro-VM: REST → BoxLite Box → /v1/shell/ws (决策 B)', () => {
  it('creates a REAL micro-VM, runs ls / over the in-sandbox agent, destroys', async () => {
    // 1) create via REST — registry routes to BoxliteSandboxProvider → BoxLite SDK.
    const created = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: 'prj-boxlite-e2e', runtime: 'claude-code', provider: 'boxlite' })
      .expect(201);
    const sandboxId = created.body.id as string;
    // ASYNC create (P1-#1): POST returns `pending`; wait out the background
    // provision (cold micro-VM boot / image pull can be slow).
    expect(created.body.status).toBe('pending');
    {
      const deadline = Date.now() + 300_000;
      let status = 'pending';
      while (Date.now() < deadline) {
        const got = await request(app.getHttpServer()).get(`/api/sandboxes/${sandboxId}`);
        status = got.body?.status;
        if (status === 'running') break;
        if (status === 'failed') throw new Error(`provision failed: ${JSON.stringify(got.body)}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(status).toBe('running');
    }
    // routing to `boxlite` is proven by a real BoxLite micro-VM coming up (aio
    // would instead create a docker container); the DTO does not surface provider.

    // 2) terminal over socket.io → forwarded :8080 → real agent PTY in the micro-VM.
    const sock = io(`http://127.0.0.1:${port}/terminal`, {
      query: { sandboxId, xSchemaHash: WS_SCHEMA_HASH },
      transports: ['websocket'],
      forceNew: true,
    });
    try {
      const session = await nextFrame(sock, (f) => f.type === 'session');
      if (session.type === 'session') {
        expect(session.socketSessionKey).toMatch(/^[0-9a-f]{32}$/);
      }
      sock.emit('frame', { type: 'input', data: 'ls /\n' });
      const out = await waitForOutput(sock, /\b(bin|etc|usr)\b/);
      expect(out).toMatch(/\b(bin|etc|usr)\b/);

      // workspace bind-mount usable by the non-root agent user inside the micro-VM.
      const wsDir = resolve(dataRoot, 'workspaces', sandboxId);
      writeFileSync(resolve(wsDir, 'host-seed.txt'), 'HOST_SEED_BL\n');
      sock.emit('frame', { type: 'input', data: 'cat /workspace/host-seed.txt\n' });
      await waitForOutput(sock, /HOST_SEED_BL/);
      sock.emit('frame', { type: 'input', data: 'echo BOX_WROTE_BL > /workspace/box-out.txt\n' });
      await waitForFileContains(resolve(wsDir, 'box-out.txt'), 'BOX_WROTE_BL');
    } finally {
      sock.disconnect();
    }

    // 3) destroy via REST.
    await request(app.getHttpServer()).delete(`/api/sandboxes/${sandboxId}`).send({}).expect(204);
    const after = await request(app.getHttpServer()).get(`/api/sandboxes/${sandboxId}`).expect(200);
    expect(after.body.status).toBe('destroyed');
  }, 420_000);
});
