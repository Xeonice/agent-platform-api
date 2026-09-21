import { describe, it, expect, vi } from 'vitest';
import { DockerContainerRuntime } from '../../src/infrastructure/providers/docker/docker-container-runtime';

/**
 * docker 侧的 `pullImage` / `hasImage` —— 2026-09-22 补的那只手。
 *
 * ── 它补的是什么 ──────────────────────────────────────────────────────────────
 * 此前**全仓只有 boxlite 实现了 `stageImage`**，docker/aio 这条路上没有任何地方拉镜像。
 * 一台 ghcr 可达、镜像只是还没下载的 docker 机器上：向导第 3 步全绿放过（答不出
 * `imageStaged`，「不知道 ≠ 没有」），然后第一次 `create()` 撞 `No such image` ——
 * 真机实测（macOS + OrbStack）就是这个形状。
 */

/** 造一个 dockerode 替身：`pull` 回一个假流，`followProgress` 按给定事件逐条回放。 */
function fakeDocker(events: unknown[], opts: { inspect?: () => Promise<unknown> } = {}) {
  return {
    pull: vi.fn().mockResolvedValue({ fake: 'stream' }),
    getImage: () => ({ inspect: opts.inspect ?? (() => Promise.resolve({})) }),
    modem: {
      followProgress: (
        _s: unknown,
        done: (e: Error | null) => void,
        onEvt: (e: unknown) => void,
      ) => {
        for (const e of events) onEvt(e);
        done(null);
      },
    },
  };
}

/**
 * ⚠️ 用构造签名收窄，⛔ 不用 `as any` —— 替身只实现了用到的那几个成员，
 * 而 `ConstructorParameters` 会在 runtime 的构造参数变化时当场编译红。
 */
const rt = (docker: unknown): DockerContainerRuntime =>
  new DockerContainerRuntime(docker as ConstructorParameters<typeof DockerContainerRuntime>[0]);

describe('DockerContainerRuntime.pullImage：进度按层取最新再求和', () => {
  it('⭐⭐ 同一层反复报 current 时不许累加 —— 累加会冲过 100%', async () => {
    const seen: number[] = [];
    // 一层从 10 涨到 100；若实现是「每个事件累加」会得到 10→30→60→100 之外的更大值。
    await rt(
      fakeDocker([
        { id: 'l1', progressDetail: { current: 10 } },
        { id: 'l1', progressDetail: { current: 50 } },
        { id: 'l1', progressDetail: { current: 100 } },
      ]),
    ).pullImage('x@sha256:aa', (n) => seen.push(n));
    // MUTATION: 把 `perLayer.set` 换成累加 ⇒ 末值变成 160，本条红。
    expect(seen).toEqual([10, 50, 100]);
  });

  it('多层时求和 —— 每层各自取最新', async () => {
    const seen: number[] = [];
    await rt(
      fakeDocker([
        { id: 'l1', progressDetail: { current: 100 } },
        { id: 'l2', progressDetail: { current: 200 } },
        { id: 'l1', progressDetail: { current: 150 } },
      ]),
    ).pullImage('x@sha256:aa', (n) => seen.push(n));
    expect(seen).toEqual([100, 300, 350]);
  });

  it('⭐ 层被丢弃重下导致回退时，如实报小的那个数', async () => {
    // ⚠️ ⛔ 不许用 Math.max 把它钉成单调 —— 那会把「下到一半断了重来」画成「一直在涨」，
    //    而 boxlite 那边实测过这个形状（153 KB/s 的链路上大层下到一半被删）。
    const seen: number[] = [];
    await rt(
      fakeDocker([
        { id: 'l1', progressDetail: { current: 900 } },
        { id: 'l1', progressDetail: { current: 20 } },
      ]),
    ).pullImage('x@sha256:aa', (n) => seen.push(n));
    expect(seen).toEqual([900, 20]);
  });

  it('没有 id / 没有 current 的事件直接跳过，⛔ 不当 0 记进层表', async () => {
    const seen: number[] = [];
    await rt(
      fakeDocker([
        { status: 'Pulling from xeonice/agent-platform-sandbox' },
        { id: 'l1', status: 'Waiting' },
        { id: 'l1', progressDetail: { current: 42 } },
      ]),
    ).pullImage('x@sha256:aa', (n) => seen.push(n));
    expect(seen).toEqual([42]);
  });

  it('不给 onProgress 也要正常完成 —— 契约两边都可选', async () => {
    await expect(
      rt(fakeDocker([{ id: 'l1', progressDetail: { current: 1 } }])).pullImage('x@sha256:aa'),
    ).resolves.toBeUndefined();
  });
});

describe('DockerContainerRuntime.hasImage：只有 404 才算「不在」', () => {
  it('inspect 成功 ⇒ true', async () => {
    await expect(rt(fakeDocker([])).hasImage('x')).resolves.toBe(true);
  });

  it('404 ⇒ false', async () => {
    const d = fakeDocker([], {
      inspect: () => Promise.reject(Object.assign(new Error('no such image'), { statusCode: 404 })),
    });
    await expect(rt(d).hasImage('x')).resolves.toBe(false);
  });

  it('⭐⭐ 非 404（连不上 daemon / 被代理挡）必须抛，⛔ 不能答 false', async () => {
    // ⚠️ 答 false 会把一次基础设施故障说成「缺镜像」，于是向导去拉一张其实已在的镜像；
    //    而「不知道」应当留在「不知道」（契约：imageStaged 是 hint 不是 gate）。
    // MUTATION: 把 catch 里的 `throw` 换成 `return false` ⇒ 本条红。
    const d = fakeDocker([], {
      inspect: () =>
        Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { statusCode: 500 })),
    });
    await expect(rt(d).hasImage('x')).rejects.toThrow();
  });
});
