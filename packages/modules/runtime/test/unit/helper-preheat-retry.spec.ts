import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ImageFacade, ProviderRegistry, SandboxProvider } from '@platform/contracts';
import { HelperContainerSession } from '../../src/infrastructure/helper/helper-container.session';

/**
 * 开机预热必须重试 —— 它与 `ImageSeeder` 赛跑，而且真的输过。
 *
 * ── 它修的是什么（2026-09-22 真机日志，同一秒内）─────────────────────────────
 *     17:17:11 WARN HelperContainerSession 预热失败：镜像还没注册进平台
 *     17:17:11 LOG  ImageSeeder            seeded built-in image …sandbox   ← 在我之后
 *
 * Nest 的 `onApplicationBootstrap` **不保证跨模块顺序**，而 `resolveImage` 要查的正是
 * seeder 刚登记的那一行。
 *
 * ⚠️⚠️ **输掉赛跑的后果不是「慢一点」，是诊断开始撒谎**：第 ⑨ 项报「帐号登录暂不可用」，
 * 而用户真去点登录时 `require()` 会重试并成功 —— **一个「说不可用但其实可用」的诊断，
 * 比没有这一项更坏**。
 */

/** 造一对 registry / images 替身；`failTimes` 次之后 `findRegisteredByRef` 才返回镜像。 */
function harness(failTimes: number) {
  let asked = 0;
  const created: string[] = [];
  // ⚠️ 补全成完整的 `SandboxProvider`:用不到的方法一律**抛**而不是给假值 ——
  //    本用例只该走 create/start/destroy,万一实现偷偷调了别的会当场炸而不是安静通过。
  const nope = (m: string) => (): never => {
    throw new Error(`本用例不该调用 provider.${m}()`);
  };
  const provider: SandboxProvider = {
    name: 'aio',
    capabilities: {
      spawnTty: true,
      volumeMount: true,
      updateResources: false,
      pauseResume: false,
      snapshot: false,
      watchEvents: false,
      headlessTask: false,
    },
    create: (ctx) => {
      created.push(ctx.sandboxId);
      return Promise.resolve({ provider: 'aio', providerSandboxId: 'cid' });
    },
    start: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
    stop: nope('stop'),
    inspect: nope('inspect'),
    spawn: nope('spawn'),
  };
  const providers = {
    defaultProvider: 'aio',
    get: (): SandboxProvider => provider,
  };
  const images = {
    findRegisteredByRef: () => {
      asked += 1;
      // 前 failTimes 次答「还没登记」—— 就是 seeder 还没跑完的那个窗口。
      return Promise.resolve(
        asked <= failTimes ? null : { ref: 'ghcr.io/x/img:latest', digest: 'sha256:aa' },
      );
    },
  };
  // ⚠️ 用 `Pick` 收窄而不是 `as unknown as`（本仓禁双重断言）：本用例只走
  //    `defaultProvider`/`get`/`create`/`start`/`destroy`/`findRegisteredByRef` 这几条,
  //    收窄后**一旦构造签名变了这里会当场编译红**,而双重断言会安静地放过去。
  const registry = providers as Pick<ProviderRegistry, 'defaultProvider' | 'get'> &
    Partial<ProviderRegistry>;
  const facade = images as Pick<ImageFacade, 'findRegisteredByRef'> & Partial<ImageFacade>;
  return {
    session: new HelperContainerSession(registry as ProviderRegistry, facade as ImageFacade),
    created,
    asked: () => asked,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HelperContainerSession：开机预热会重试', () => {
  it('⭐⭐ 第一次输给 seeder ⇒ 重试后仍然就绪（此前是永久放弃）', async () => {
    vi.useFakeTimers();
    const { session, created } = harness(1); // 只有第 1 次查不到
    session.onApplicationBootstrap();

    // 第一次失败后要等退避；把时钟推过去。
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(session.status().ready).toBe(true));

    // MUTATION: 把 preheat 改回「一次不成就放弃」⇒ ready 恒 false，本条红。
    expect(created).toEqual(['auth-helper']);
  });

  it('⛔ 一直失败也要停下来，不许无限重试把「真缺镜像」掩盖成「一直在准备中」', async () => {
    vi.useFakeTimers();
    const { session, asked } = harness(Number.POSITIVE_INFINITY);
    session.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(session.status().starting).toBe(false));

    expect(session.status().ready).toBe(false);
    // 5 次上限 —— ⛔ 不是 50 次也不是无限。
    expect(asked()).toBeLessThanOrEqual(5);
    expect(session.status().lastError).toMatch(/还没注册进平台/);
  });
});

describe('HelperContainerSession：require() 不重试', () => {
  it('⭐ 用户点登录时一次定生死 —— 人在等，快速失败好过静默重试一分钟', async () => {
    const { session, asked } = harness(Number.POSITIVE_INFINITY);
    await expect(session.require()).rejects.toThrow(/auth helper 容器不可用/);
    // MUTATION: 让 require 也走 preheat ⇒ 这里会变成 5 次，本条红。
    expect(asked()).toBe(1);
  });
});
