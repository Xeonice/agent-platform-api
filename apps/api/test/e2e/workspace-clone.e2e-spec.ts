import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
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
import {
  createDockerClient,
  isDockerAvailable,
} from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-client';

/**
 * S2 ACCEPTANCE (docs/backend/03 §7.1): a git project's cloned files really land
 * in the sandbox `/workspace` (baseline → workspace copy at preparing-workspace),
 * and an empty project yields an empty workspace. Full chain: POST project (clone)
 * → ready → POST sandbox → running → terminal `ls /workspace`.
 *
 * Requires docker (AIO image) AND network (git clone). SKIPS LOUDLY otherwise.
 */
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? 'ghcr.io/agent-infra/sandbox:latest';
const PUBLIC_REPO = process.env.E2E_PUBLIC_REPO ?? 'https://github.com/octocat/Hello-World.git';
const docker = createDockerClient();
const dockerUp = await isDockerAvailable(docker).catch(() => false);
async function networkUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    await fetch('https://github.com', { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}
const netUp = dockerUp && (await networkUp());
const ready = dockerUp && netUp;
if (!ready) {
  console.warn(
    `\n[33m[workspace-clone.e2e] SKIPPED — docker=${dockerUp} network=${netUp}. ` +
      'This is the git-clone → /workspace acceptance (needs both). NOT fake-passed.[0m\n',
  );
}

let app: INestApplication;
let port: number;
let dataRoot: string;
const createdContainers = new Set<string>();

function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;?]*[A-Za-z]/g, '');
}
function waitForOutput(sock: Socket, re: RegExp, ms = 15000): Promise<string> {
  return new Promise((resolveP, reject) => {
    let acc = '';
    const t = setTimeout(() => reject(new Error(`output timeout; got ${JSON.stringify(acc)}`)), ms);
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
async function waitForRunning(id: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const got = await request(app.getHttpServer()).get(`/api/sandboxes/${id}`);
    if (got.body?.status === 'running') return;
    if (got.body?.status === 'failed')
      throw new Error(`sandbox failed: ${JSON.stringify(got.body)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`sandbox ${id} never running`);
}
async function waitForProject(id: string, want: string, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const got = await request(app.getHttpServer()).get(`/api/projects/${id}`);
    if (got.body?.cloneStatus === want) return;
    if (got.body?.cloneStatus === 'failed' && want !== 'failed') {
      throw new Error(`clone failed: ${JSON.stringify(got.body)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`project ${id} never ${want}`);
}

async function lsWorkspace(sandboxId: string): Promise<string> {
  const sock = io(`http://127.0.0.1:${port}/terminal`, {
    query: { sandboxId, xSchemaHash: WS_SCHEMA_HASH },
    transports: ['websocket'],
    forceNew: true,
  });
  try {
    await new Promise<TerminalServerFrame>((res, rej) => {
      const t = setTimeout(() => rej(new Error('no session')), 8000);
      sock.on('frame', (f: TerminalServerFrame) => {
        if (f.type === 'session') {
          clearTimeout(t);
          res(f);
        }
      });
    });
    // the marker is split (D''ONE_MARK) so the shell PRINTS "DONE_MARK" while the
    // ECHOED command shows "D''ONE_MARK" — matching /DONE_MARK/ hits only real output,
    // not the command echo.
    sock.emit('frame', { type: 'input', data: "ls -a /workspace; echo D''ONE_MARK\n" });
    return await waitForOutput(sock, /DONE_MARK/);
  } finally {
    sock.disconnect();
  }
}

beforeAll(async () => {
  if (!ready) return;
  process.env.DATABASE_URL = ':memory:';
  dataRoot = mkdtempSync(resolve(process.cwd(), 'tmp-wsclone-e2e-'));
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
  for (const name of createdContainers) {
    await docker
      .getContainer(name)
      .remove({ force: true })
      .catch(() => undefined);
  }
  await app?.close();
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
});

describe.skipIf(!ready)('git project → sandbox /workspace holds the cloned repo', () => {
  it('a cloned repo file (README) is visible in /workspace; empty project is empty', async () => {
    // 1) git project → ready
    const proj = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'clone-ws', sourceType: 'git', repoUrl: PUBLIC_REPO })
      .expect(202);
    const projectId = proj.body.id as string;
    await waitForProject(projectId, 'ready');

    // 2) sandbox on that project → running
    const created = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId, runtime: 'claude-code', provider: 'aio' })
      .expect(201);
    const sandboxId = created.body.id as string;
    createdContainers.add(`platform-aio-${sandboxId}`);
    await waitForRunning(sandboxId);

    // 3) terminal ls /workspace → the cloned README is there
    const out = await lsWorkspace(sandboxId);
    expect(out).toMatch(/README/);
    await request(app.getHttpServer()).delete(`/api/sandboxes/${sandboxId}`).send({}).expect(204);
    createdContainers.delete(`platform-aio-${sandboxId}`);

    // 4) empty project → /workspace has NO repo files
    const empty = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'empty-ws', sourceType: 'empty' })
      .expect(202);
    const emptyProjectId = empty.body.id as string;
    const created2 = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId: emptyProjectId, runtime: 'claude-code', provider: 'aio' })
      .expect(201);
    const sandboxId2 = created2.body.id as string;
    createdContainers.add(`platform-aio-${sandboxId2}`);
    await waitForRunning(sandboxId2);

    const out2 = await lsWorkspace(sandboxId2);
    expect(out2).not.toMatch(/README/);
    await request(app.getHttpServer()).delete(`/api/sandboxes/${sandboxId2}`).send({}).expect(204);
    createdContainers.delete(`platform-aio-${sandboxId2}`);
  }, 300_000);
});
