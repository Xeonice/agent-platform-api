import { mkdtempSync, rmSync } from 'node:fs';
import { boxliteNamePrefix } from '@platform/sandbox';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { sandboxShell } from './_sandbox-shell';
import { setupWebsockets } from '../../src/bootstrap/websocket.setup';
import { platformValidationPipe } from '../../src/bootstrap/validation.pipe';
import {
  createDockerClient,
  isDockerAvailable,
} from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-client';
import { getSharedBoxliteRuntime } from '../../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-runtime';

/**
 * S2 ACCEPTANCE, PARAMETERIZED over BOTH provider tiers (aio docker container +
 * boxlite micro-VM): a git project's cloned files really land in the sandbox
 * `/workspace` (baseline → workspace copy at preparing-workspace), and an empty
 * project yields an empty workspace. Full chain per provider: POST project (clone)
 * → ready → POST sandbox {provider} → running → terminal `ls /workspace`.
 *
 * Skips LOUDLY per tier: aio needs docker + network + the AIO image; boxlite
 * ADDS the BoxLite native binary + the local `:5001` registry image.
 */
// NOTE (S5): the runtime matters now — `starting` really installs the CLI (03 §4.3 ③).
// `agent-infra/sandbox` ships codex preinstalled but NOT claude-code (a measured 753s
// install, 04 §3 ★1), so this workspace test uses codex: it is about the workspace,
// not about spending 12 minutes on an npm install.
const PUBLIC_REPO = process.env.E2E_PUBLIC_REPO ?? 'https://github.com/octocat/Hello-World.git';
const REGISTRY = process.env.SANDBOX_BOXLITE_REGISTRY ?? 'localhost:5001';
const AIO_IMAGE = process.env.SANDBOX_TEST_IMAGE ?? 'ghcr.io/agent-infra/sandbox:latest';
const BOXLITE_IMAGE = `${REGISTRY}/agent-infra/sandbox:latest`;

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
const netUp = await networkUp();

const SANDBOX_PKG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/modules/sandbox/package.json',
);
function boxliteBinaryPresent(): boolean {
  try {
    createRequire(SANDBOX_PKG)('@boxlite-ai/boxlite');
    return true;
  } catch {
    return false;
  }
}
async function registryServingImage(): Promise<boolean> {
  try {
    const res = await fetch(`http://${REGISTRY}/v2/agent-infra/sandbox/tags/list`);
    if (!res.ok) return false;
    const body = (await res.json()) as { tags?: string[] };
    return Array.isArray(body.tags) && body.tags.includes('latest');
  } catch {
    return false;
  }
}
// The AIO Sandbox image is ~3.3GB; do NOT auto-pull on CI. Skip unless present locally.
async function imagePresent(ref: string): Promise<boolean> {
  if (!dockerUp) return false;
  return docker
    .getImage(ref)
    .inspect()
    .then(() => true)
    .catch(() => false);
}
const aioImagePresent = await imagePresent(AIO_IMAGE);
const boxliteReady = dockerUp && netUp && boxliteBinaryPresent() && (await registryServingImage());
const aioReady = dockerUp && netUp && aioImagePresent;

const PROVIDERS = [
  {
    provider: 'aio',
    image: AIO_IMAGE,
    ready: aioReady,
    why: `docker=${dockerUp} net=${netUp} image=${aioImagePresent}`,
  },
  {
    provider: 'boxlite',
    image: BOXLITE_IMAGE,
    ready: boxliteReady,
    why: `docker=${dockerUp} net=${netUp} boxlite=${boxliteBinaryPresent()} registry@${REGISTRY}`,
  },
] as const;

for (const p of PROVIDERS) {
  if (!p.ready) {
    console.warn(
      `\n[33m[workspace-clone.e2e:${p.provider}] SKIPPED — prerequisites missing (${p.why}). ` +
        'This is the git-clone → /workspace acceptance. NOT fake-passed.[0m\n',
    );
  }
}

async function waitForRunning(app: INestApplication, id: string, ms = 60_000): Promise<void> {
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
async function waitForProject(
  app: INestApplication,
  id: string,
  want: string,
  ms = 120_000,
): Promise<void> {
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
/**
 * List `/workspace` inside a live sandbox over the ONE-SHOT EXEC data plane.
 *
 * It used to type `ls -a /workspace` into the terminal, but since S5 the terminal
 * attaches the platform tmux session, which is running the AGENT CLI (裁决 D-15 /
 * 26 §8) — the keyboard is the agent's. The exec path reaches the same in-sandbox
 * agent and the same bind mount, so what this asserts is unchanged.
 */
async function lsWorkspace(app: INestApplication, sandboxId: string): Promise<string> {
  const shell = await sandboxShell(app, sandboxId);
  return shell('ls -a /workspace');
}

for (const p of PROVIDERS) {
  describe.skipIf(!p.ready)(
    `git project → ${p.provider} sandbox /workspace holds the cloned repo`,
    () => {
      let app: INestApplication;
      let dataRoot: string;
      const createdContainers = new Set<string>();
      const createdBoxNames = new Set<string>();

      beforeAll(async () => {
        process.env.DATABASE_URL = ':memory:';
        dataRoot = mkdtempSync(resolve(process.cwd(), `tmp-wsclone-${p.provider}-`));
        process.env.DATA_ROOT = dataRoot;
        process.env.SANDBOX_DEFAULT_IMAGE = p.image;
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        app.setGlobalPrefix('api');
        app.useGlobalPipes(platformValidationPipe());
        setupWebsockets(app);
        await app.init();
        // Keep the server LISTENING even though the workspace assertions now use the
        // in-process exec plane: supertest otherwise lazily `listen(0)`s per request,
        // and this file shares its process with every other e2e (singleFork).
        await app.listen(0);
      }, 60_000);

      afterAll(async () => {
        for (const name of createdContainers) {
          await docker
            .getContainer(name)
            .remove({ force: true })
            .catch(() => undefined);
        }
        if (p.provider === 'boxlite' && createdBoxNames.size > 0) {
          const rt = await getSharedBoxliteRuntime().catch(() => null);
          if (rt) {
            const boxes = await rt.listInfo().catch(() => []);
            for (const b of boxes) {
              if (b.name && createdBoxNames.has(b.name))
                await rt.remove(b.id, true).catch(() => undefined);
            }
          }
        }
        await app?.close();
        if (dataRoot) rmSync(dataRoot, { recursive: true, force: true });
      });

      // ⚠️ boxlite 的名字里现在带**实例指纹**（回收作用域，见 reconcile/instance-id）。
      // 照旧拼 `platform-boxlite-<id>` 的话，`afterAll` 里 `has(b.name)` 永远不成立、
      // 清理循环静默 no-op —— e2e 每跑一轮泄漏一批 micro-VM，而这个分支的动机恰恰
      // 是"e2e 不该乱删东西"。用与生产者同一个前缀函数。
      const boxNameOf = (sandboxId: string): string => `${boxliteNamePrefix()}${sandboxId}`;
      function trackRuntimeEntity(sandboxId: string): void {
        if (p.provider === 'boxlite') createdBoxNames.add(boxNameOf(sandboxId));
        else createdContainers.add(`platform-${p.provider}-${sandboxId}`);
      }
      function untrackRuntimeEntity(sandboxId: string): void {
        createdBoxNames.delete(boxNameOf(sandboxId));
        createdContainers.delete(`platform-${p.provider}-${sandboxId}`);
      }

      async function sandboxOnProject(projectId: string): Promise<string> {
        const created = await request(app.getHttpServer())
          .post('/api/sandboxes')
          .send({ projectId, runtime: 'codex', provider: p.provider })
          .expect(201);
        const sandboxId = created.body.id as string;
        trackRuntimeEntity(sandboxId);
        await waitForRunning(app, sandboxId);
        return sandboxId;
      }

      it('a cloned repo file (README) is visible in /workspace; empty project is empty', async () => {
        // 1) git project → ready → sandbox → README visible in /workspace
        const proj = await request(app.getHttpServer())
          .post('/api/projects')
          .send({ name: `clone-ws-${p.provider}`, sourceType: 'git', repoUrl: PUBLIC_REPO });
        expect(proj.status, `create project answered ${JSON.stringify(proj.body)}`).toBe(202);
        const projectId = proj.body.id as string;
        await waitForProject(app, projectId, 'ready');

        const sandboxId = await sandboxOnProject(projectId);
        const out = await lsWorkspace(app, sandboxId);
        expect(out).toMatch(/README/);
        await request(app.getHttpServer())
          .delete(`/api/sandboxes/${sandboxId}`)
          .send({})
          .expect(204);
        untrackRuntimeEntity(sandboxId);

        // 2) empty project → /workspace has NO repo files
        const empty = await request(app.getHttpServer())
          .post('/api/projects')
          .send({ name: `empty-ws-${p.provider}`, sourceType: 'empty' })
          .expect(202);
        const sandboxId2 = await sandboxOnProject(empty.body.id as string);
        const out2 = await lsWorkspace(app, sandboxId2);
        expect(out2).not.toMatch(/README/);
        await request(app.getHttpServer())
          .delete(`/api/sandboxes/${sandboxId2}`)
          .send({})
          .expect(204);
        untrackRuntimeEntity(sandboxId2);
      }, 300_000);
    },
  );
}
