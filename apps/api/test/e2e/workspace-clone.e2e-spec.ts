import { mkdtempSync, rmSync } from 'node:fs';
import { boxliteNamePrefix } from '@platform/sandbox';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { IMAGE_SPEC_REGISTRY } from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { makeFakeImageSpecRegistry, registerDefaultImage } from './_fakes';
import { sandboxShell } from './_sandbox-shell';
import { setupWebsockets } from '../../src/bootstrap/websocket.setup';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';
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
/**
 * ⚠️ **平台自己构建的那张，不是上游 AIO 镜像。**
 *
 * 这里曾经是 `${REGISTRY}/agent-infra/sandbox:latest`——上游镜像。它在 2026-08「血统 +
 * tmux 约定」（04 §7）之后**不再满足平台约定**：provision 到 `assertImageContract` 那步
 * 直接失败（`镜像缺少 tmux，不满足平台约定`）。而这条用例长期因为缺 docker/registry 被
 * `skipIf` 跳过，**夹具过时了一整轮都没人发现**——它一跑起来就是红的。
 *
 * 平台镜像（`api/images/platform-base`）带 `platform.tmux` 标签、装了 tmux，
 * 也正是 `SANDBOX_DEFAULT_IMAGE` 该指的那张。
 */
const BOXLITE_IMAGE = process.env.SANDBOX_BOXLITE_TEST_IMAGE ?? `${REGISTRY}/platform/base:v1`;

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
/**
 * ⚠️ 查的必须是 **`BOXLITE_IMAGE` 那一张**，不是随便某张镜像。
 * 此前它查 `agent-infra/sandbox:latest` 而用例跑的也是那张，二者碰巧一致；
 * 现在用例改用平台镜像，如果这里还查上游，就会出现「registry 里有上游镜像 ⇒ 判定就绪
 * ⇒ 真跑时拉不到平台镜像」——一个**看起来像代码坏了**的环境问题。
 */
async function registryServingImage(): Promise<boolean> {
  const [repo, tag] = BOXLITE_IMAGE.slice(REGISTRY.length + 1).split(':');
  try {
    const res = await fetch(`http://${REGISTRY}/v2/${String(repo)}/tags/list`);
    if (!res.ok) return false;
    const body = (await res.json()) as { tags?: string[] };
    return Array.isArray(body.tags) && body.tags.includes(String(tag));
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
    startupBudgetMs: 60_000,
    why: `docker=${dockerUp} net=${netUp} image=${aioImagePresent}`,
  },
  {
    provider: 'boxlite',
    image: BOXLITE_IMAGE,
    ready: boxliteReady,
    /**
     * 微 VM 起得比容器慢：实测（2026-08-26，本机 M9 / boxlite 0.9.7 / 12GB 平台镜像）
     * store 已缓存时首次起 box **237s**（转 ext4 + 建 COW），再次 **85s**；store 为空
     * 还要先拉一个 12GB 的单层。60 秒是按 docker 容器定的，微 VM 达不到。
     *
     * ⚠️ **更正一条我先前写在这里的错误结论。** 本条曾经稳定报 `never running`，
     * 我据此写下「冷缓存下拉 12GB 超时，本机首次必须预热」。**那是错的**——
     * 后来跑全量 e2e 时它 96 秒就失败了，`failureCode` 是：
     *
     *   INSTALL_FAILED: image localhost:5001/platform/base:v1 declares 'codex' as
     *                   preinstalled, but it is not present in the running sandbox
     *
     * 真正的原因是**沙箱内 rootfs 不完整**：boxlite 在 macOS 上构建 rootfs 时
     * `cp -a` 撞上 OverlayFS 的 whiteout 文件（`.wh.*`）报 Permission denied，
     * 回退到 extraction-based mount 之后，`codex` 和 agent 的 python-server 都缺失。
     * 同一份 e2e 日志里 `boxlite-microvm.e2e` 是**通过**的（另一个 BOXLITE_HOME、
     * 上游镜像），所以 boxlite 本身没问题，坏的是那一份层缓存。
     *
     * ⛔ 教训：`never running` 只说明"等够了还没起来"，**不说明为什么**。我把它读成
     * "还在下载"，是拿一个**看起来合理的解释**替代了去查 `failureCode`——而那个字段
     * 一直就在响应体里。判据要取自平台自己报的原因，不是从耗时反推。
     */
    startupBudgetMs: 300_000,
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

/**
 * ⚠️ **60 秒是按 docker 容器定的预算，微 VM 达不到。**
 *
 * 本机实测（boxlite 0.9.7，12GB 平台镜像）：首次启动 **237 秒**——大头是把 OCI 镜像
 * 转成 ext4 磁盘（`Normalized 255479 inodes in 24s`）再建 COW 叠加层；磁盘缓存命中后
 * **85 秒**。60 秒的预算让这条用例稳定报 `never running`，读起来像 provision 挂了，
 * 实际只是**等得不够久**——而它长期被 skip，这个偏差一直没暴露。
 *
 * aio（docker 容器）秒级即可，所以预算按 provider 给，不是一个数字通吃。
 */
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
        // Keep the server LISTENING even though the workspace assertions now use the
        // in-process exec plane: supertest otherwise lazily `listen(0)`s per request,
        // and this file shares its process with every other e2e (singleFork).
        await app.listen(0);
        // 04 §7 时刻③: the create door only accepts a REGISTERED image now.
        await registerDefaultImage(app);
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
        await waitForRunning(app, sandboxId, p.startupBudgetMs);
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
        // ⚠️ **必须大于 `startupBudgetMs`**：否则 vitest 先掐断，错误从
        //    「sandbox never running（等够了还没起来）」变成「Test timed out」——
        //    后者读不出是谁慢，排查会从 provision 一路查到网络。
      }, 420_000);
    },
  );
}
