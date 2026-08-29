import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { WS_SCHEMA_HASH } from '@platform/contracts';
import type { TerminalServerFrame } from '@platform/contracts';
import { IMAGE_SPEC_REGISTRY } from '@platform/contracts';
import { AppModule } from '../../src/app.module';
import { makeFakeImageSpecRegistry, registerDefaultImage } from './_fakes';
import { useEnv } from './_env';
import { sandboxShell } from './_sandbox-shell';
import { setupWebsockets } from '../../src/bootstrap/websocket.setup';
import { configurePlatformApp } from '../../src/bootstrap/configure-app';

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
// NOTE (S5): the runtime matters now — `starting` really installs the CLI (03 §4.3 ③).
// `agent-infra/sandbox` ships codex preinstalled but NOT claude-code (a measured 753s
// install, 04 §3 ★1), so these workspace/micro-VM tests use codex: they are about the
// workspace and the micro-VM, not about spending 12 minutes on an npm install.
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
let restoreEnv: (() => void) | undefined;

beforeAll(async () => {
  if (!ready) return;
  process.env.DATABASE_URL = ':memory:';
  dataRoot = mkdtempSync(resolve(process.cwd(), 'tmp-boxlite-e2e-'));
  process.env.DATA_ROOT = dataRoot;
  // ⚠️ **`SANDBOX_DEFAULT_IMAGE` 必须走 `useEnv`,不能裸赋值。** 每个 e2e 文件共享同一个
  // 进程(singleFork),而这个变量决定 `ImageSeeder` 在**后面每一个文件**的 `app.init()`
  // 里去播种哪张镜像 —— 泄漏出去之后,`registry-extension.e2e` 的
  // `registerImage(SANDBOX_DEFAULT_IMAGE ?? 'alpine:3.20')` 会撞上「播种时已经注册过了」
  // 而 `created:false`。实测踩到过一次(2026-08-29,本机装了 AIO 镜像因此这几个文件真的
  // 跑了起来);**CI 里因为没有那张镜像、这三个文件全被跳过,所以泄漏从来没发生过** ——
  // 一个只在「测试真的跑起来时」才出现的串扰。
  restoreEnv = useEnv({ SANDBOX_DEFAULT_IMAGE: IMAGE });

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
  await app?.close();
  restoreEnv?.();
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

/**
 * 去掉 ANSI 转义序列。
 *
 * ⚠️ **这里曾经漏了 ESC 前缀**（`/\[[0-9;?]*[A-Za-z]/g`），于是它把任何「`[` + 一个
 * 字母」都当成转义序列吃掉 —— tmux 状态栏的 `[platform-0:bash*` 会被啃成
 * `latform-0:bash*`，下面那条 `/\[platform/` 因此**永远匹配不上**。
 *
 * 之所以一直没红，是因为它当时匹配上的其实是**另一样东西**：aio 那条数据面的
 * `openTerminal` 是把 `exec tmux attach -t platform-agent` **敲进 shell**，shell 回显
 * 把 `tmux` / `platform-agent` 这两个词送回了终端。boxlite 换成 native `Box.exec`
 * 之后 `spec.cmd` 直接就是进程的 argv（顺带补上了 04 §2.3★ 记的那笔「tty:true 一侧
 * spec.cmd 传不进去」的账），没有 shell 去回显它 —— 断言这才露出它一直在测回显、
 * 而不是在测「终端真的附着到了平台的 tmux 会话」。修好 ESC 之后状态栏能留下来，
 * 断言测的就是它本来该测的那个东西了。
 */
function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;?>]*[A-Za-z]|[()][A-Za-z0-9]|[=>]|\][^]*/g, '');
}

/**
 * host → micro-VM 方向的等待。
 *
 * 为什么只有 boxlite 这条加、aio 那条（`terminal-container.e2e-spec.ts`）不加：**实测**
 * 这一步在全量套件下会偶发拿到空串（`cat` 既不报错也没内容），单跑从不复现；aio 那条从
 * 未观察到同样现象。
 *
 * ⚠️ **真因尚未查明，不要在这里写一个听起来合理的机制。** 曾经写过"跨 VM 边界 virtio-fs
 * 传播非瞬时"——**已被实测推翻**：直接量宿主写入到 guest 可见的延迟是 **3ms**（经
 * `/v1/file/download` 通道，2026-08）。而本函数用的是 `spawn({tty:false})` →
 * `/v1/bash/exec` 同步通道，两者不是一条路，所以那个测量既没证实也没否定这条路上的机制。
 *
 * 这个等待**不削弱断言**：内容仍然必须出现，只是像反方向的 `waitForFileContains` 一样
 * 给它时间。挂载真坏了，重试到超时照样红——它区分的是"慢/有竞态"和"坏"，不是把坏藏起来。
 * 真因查明前，这里是**缓解**不是修复。
 *
 * ── 已排除的候选（2026-08 复查，写下来是为了不再查第二遍）────────────────────────
 * ① **`AioExecProcessStream` 的"晚订阅丢数据"竞态**：不成立。它对 settle 之后才注册的
 *    `onData`/`onExit` 都会**补发**（`if (this.settled …) cb(…)`），且 `settle` 有幂等
 *    守卫；`_sandbox-shell.ts` 的 `collect` 先 `onData` 后 `onExit`，两种时序都拿得到。
 * ② **`cat` 报错被吞**：不成立。客户端把 `output` 拼成 `stdout + stderr`
 *    （`aio-sandbox-agent.client.ts#runExec`），所以 `cat: No such file` 会**出现在**结果里。
 *    观察到的却是**纯空串**——这反而把"文件真没有"排除掉了。
 *
 * ⇒ 剩下的候选集中在 agent 侧：`{success:true}` 但 `data` 缺失（⇒ exitCode `null`），
 *   或 `hard_timeout`（⇒ 124）。两者之前都被 `collect` 压成空串，无从分辨；现在
 *   `collect` 会在空输出时带上 exitCode，**下一次偶发就能自证是哪一种**。
 */
async function waitForShellContains(
  shell: (cmd: string) => Promise<string>,
  cmd: string,
  needle: string,
  ms = 10000,
): Promise<string> {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    last = await shell(cmd);
    if (last.includes(needle)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`in-sandbox \`${cmd}\` never contained ${needle}; last: ${JSON.stringify(last)}`);
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
    // 0) real (empty) project — the sandbox create validates it via the facade.
    const projectRes = await request(app.getHttpServer())
      .post('/api/projects')
      .send({ name: 'proj-boxlite', sourceType: 'empty' })
      .expect(202);
    const projectId = projectRes.body.id as string;

    // 1) create via REST — registry routes to BoxliteSandboxProvider → BoxLite SDK.
    const created = await request(app.getHttpServer())
      .post('/api/sandboxes')
      .send({ projectId, runtime: 'codex', provider: 'boxlite' })
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
      // S5: the gateway ATTACHES the platform tmux session provision started, so the
      // terminal belongs to the agent CLI, not to a shell (裁决 D-15 / 26 §8). Assert
      // the attach really happened, then do the shell work over the exec plane.
      await waitForOutput(sock, /tmux|platform-agent|\[platform/i);

      const shell = await sandboxShell(app, sandboxId);
      expect(await shell('ls /')).toMatch(/\b(bin|etc|usr)\b/);
      // The session is held by the micro-VM's OWN tmux server — the reason a platform
      // restart cannot interrupt a running agent (04 §7 ★). Ask via `has-session` and
      // echo the code: `tmux ls` reports "no server running" on STDERR, and the
      // platform's `toExecFn` collects a single demultiplexed stream (04 §2.4), so an
      // empty result would be indistinguishable from "the probe itself failed".
      expect(await shell('tmux has-session -t platform-agent; echo rc=$?')).toContain('rc=0');

      // workspace bind-mount usable by the non-root agent user inside the micro-VM,
      // while the shared parent stays untraversable to other local users (加固 2).
      const wsDir = resolve(dataRoot, 'workspaces', sandboxId);
      expect(statSync(resolve(dataRoot, 'workspaces')).mode & 0o777).toBe(0o700);
      expect(statSync(wsDir).mode & 0o777).toBe(0o777);
      writeFileSync(resolve(wsDir, 'host-seed.txt'), 'HOST_SEED_BL\n');
      // 跨 VM 边界，要等传播——理由见 `waitForShellContains` 的注释。
      await waitForShellContains(shell, 'cat /workspace/host-seed.txt', 'HOST_SEED_BL');
      await shell('echo BOX_WROTE_BL > /workspace/box-out.txt');
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
