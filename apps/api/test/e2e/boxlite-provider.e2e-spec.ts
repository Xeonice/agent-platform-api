import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterAll, describe, it, expect } from 'vitest';
import type { ProcessStream, SandboxHandle, SandboxProviderContext } from '@platform/contracts';
import { BoxliteSandboxProvider } from '../../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-sandbox.provider';

/**
 * BOXLITE-REQUIRED provider-level e2e（决策 B + **决策 A 修订**）——直接驱动
 * `BoxliteSandboxProvider`，因为要控制 handle 本身。
 *
 * ══ 这个文件上一版测的是什么、为什么整个改掉 ═══════════════════════════════
 * 上一版钉的是「**转发端口**跨后端重启还能用」：`create()` 要吐出
 * `agentEndpointPort`，重启后拿它 + `agentAuthToken` 重建 handle 才能接回沙箱内那个
 * HTTP agent；还配了一条反向用例「没有端口就必须**响亮失败**」。
 *
 * 数据面换成 BoxLite native 之后，那三样东西**都不存在了**：没有端口、没有 token、
 * `providerState` 是空的。但它们守护的那个**需求**一点没变——「后端重启之后，终端和
 * exec 还能接回同一个实例」。所以本文件保留同一个意图，换成 native 下的表述：
 *
 *   (A) 重启接回：**全新的 provider 实例 + 只凭 `providerSandboxId` 重建的 handle**
 *       仍然能 exec。⚠️ 反向断言换成了更强的一条：`providerState` **必须是空的**——
 *       只要它又长出键来，就说明数据面偷偷依赖上了某种「地址」，那正是这次要拆掉的。
 *   (B) stop→restart：rootfs 文件跨停启存活（03 §4 stopped→starting 复用）。
 *       ⚠️ 顺带钉住一个实测踩过的坑：`box.stop()` 会**作废旧的 Box 句柄**
 *       （`Handle invalidated after stop(). Use runtime.get()`），所以实现每次调用
 *       都必须重新 `runtime.get(id)`；provider 若把 Box 缓存起来，这一条会红。
 *   (C) native 独有能力：`ProcessSpec.user` 在这一档是**原生支持**的（aio 侧抛
 *       `UNSUPPORTED_CAPABILITY`），`timeoutMs` 到点真杀并归一成 124。
 *
 * 缺少前提时**响亮 skip**（绝不假过），afterAll 兜底清理泄漏的 detached box。
 */
const REGISTRY = process.env.SANDBOX_BOXLITE_REGISTRY ?? 'localhost:5001';
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? `${REGISTRY}/agent-infra/sandbox:latest`;
const SANDBOX_PKG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/modules/sandbox/package.json',
);
const requireFromSandbox = createRequire(SANDBOX_PKG);

function boxliteBinaryPresent(): boolean {
  try {
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
    '\n\x1b[33m========================================================================\n' +
      '[boxlite-provider.e2e] SKIPPED — BoxLite micro-VM prerequisites missing:\n' +
      `  - BoxLite native binary present: ${boxliteReady}\n` +
      `  - local registry ${REGISTRY} serving agent-infra/sandbox:latest: ${registryReady}\n` +
      'Pins restart-reconnect WITHOUT any persisted endpoint + stop/restart persistence.\n' +
      'NOT fake-passed.\n' +
      '========================================================================\x1b[0m\n',
  );
}

const createdBoxIds = new Set<string>();

function ctxFor(sandboxId: string): SandboxProviderContext {
  return {
    sandboxId,
    quota: { cores: 2, ramMb: 2048, diskMb: 4096 },
    image: { ref: IMAGE, digest: 'sha256:boxlite-provider-e2e' },
    env: {},
    volumes: [],
    labels: {},
  };
}

function collect(stream: ProcessStream): Promise<{ out: string; code: number | null }> {
  return new Promise((res) => {
    let out = '';
    stream.onData((c) => {
      out += c.toString('utf8');
    });
    stream.onExit((code) => res({ out, code }));
  });
}

afterAll(async () => {
  for (const id of createdBoxIds) {
    await new BoxliteSandboxProvider()
      .destroy({ provider: 'boxlite', providerSandboxId: id })
      .catch(() => undefined);
  }
});

describe.skipIf(!ready)(
  'BoxliteSandboxProvider — native data plane: restart reconnect + stop/restart (决策 A 修订 / B)',
  () => {
    it('reconnects with NOTHING but the box id, and preserves rootfs across stop→restart', async () => {
      const p1 = new BoxliteSandboxProvider();
      const sandboxId = `blprov-${Date.now()}`;
      const handle = await p1.create(ctxFor(sandboxId));
      createdBoxIds.add(handle.providerSandboxId);
      await p1.start(handle);

      // ⚠️ 反向断言（替代上一版的「没有端口就要响亮失败」）：boxlite 的 providerState
      // 必须**空**。它一旦又长出键来，就说明数据面重新依赖上了某种需要持久化的
      // 「地址/凭证」——那正是决策 A 修订要拆掉的东西。
      expect(
        handle.providerState === undefined || Object.keys(handle.providerState).length === 0,
      ).toBe(true);

      const s1 = await p1.spawn(handle, { tty: false, cmd: ['sh', '-c', 'echo HELLO_NATIVE'] });
      expect((await collect(s1)).out).toContain('HELLO_NATIVE');

      // (A) 重启接回：全新 provider 实例（进程内状态全空）+ 只凭 providerSandboxId
      // 重建的 handle。native 通道没有「可达地址」这回事，所以这就是全部所需。
      const persisted: SandboxHandle = {
        provider: 'boxlite',
        providerSandboxId: handle.providerSandboxId,
      };
      const p2 = new BoxliteSandboxProvider();
      const s2 = await p2.spawn(persisted, { tty: false, cmd: ['sh', '-c', 'echo RECONNECT_OK'] });
      expect((await collect(s2)).out).toContain('RECONNECT_OK');

      // (C) native 独有：`user` 是原生参数（aio 侧是 UNSUPPORTED_CAPABILITY）。
      const asRoot = await collect(
        await p1.spawn(handle, { tty: false, cmd: ['id'], user: 'root' }),
      );
      expect(asRoot.out).toContain('uid=0(root)');
      // 到点真杀，并归一成平台的 124（native 自己报的是 -15，与一次普通 SIGTERM 无异）。
      const timedOut = await collect(
        await p1.spawn(handle, { tty: false, cmd: ['sleep', '30'], timeoutMs: 1500 }),
      );
      expect(timedOut.code).toBe(124);

      // (B) stop→restart：写一个 rootfs 文件，停、起、读回来。
      await collect(
        await p1.spawn(handle, {
          tty: false,
          cmd: ['sh', '-c', 'echo ROOTFS_PERSIST > /var/tmp/persist.txt'],
        }),
      );
      await p1.stop(handle);
      // ⚠️ stop 之后 Box 句柄失效，start/spawn 必须重新 runtime.get()；provider 若
      // 缓存 Box，这一步会抛 `Handle invalidated after stop()`。
      await p1.start(handle);
      const s3 = await p1.spawn(handle, { tty: false, cmd: ['cat', '/var/tmp/persist.txt'] });
      expect((await collect(s3)).out).toContain('ROOTFS_PERSIST');

      await p1.destroy(handle);
      createdBoxIds.delete(handle.providerSandboxId);
    }, 600_000);
  },
);
