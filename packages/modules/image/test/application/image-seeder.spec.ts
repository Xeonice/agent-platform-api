import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { ImageSeeder } from '../../src/application/image-seeder';
import { Image } from '../../src/domain/entities/image.entity';
import type { ImageRepository } from '../../src/domain/repositories/image.repository';
import type { ImageApplicationService } from '../../src/application/image-application.service';

/**
 * ★ 开机播种 —— 它修的是一个**把全新部署变成不可用**的缺口。
 *
 * 镜像切片把建 Task 的门口改成「只接受注册过、解析出 digest 的镜像」（04 §7 时刻③）。
 * 全新部署的 `images` 表是空的 ⇒ 第一个 Task 就被门口拒。
 *
 * ⚠️ **而 e2e 177 条全绿**：11 个 e2e 文件都调用了测试专用的 `registerDefaultImage(app)`。
 * 测试自己把种子播了，产品没有 —— 缺口因此在测试里完全不可见
 * （LIVE-RUN-FINDINGS 共性 2「脚手架替产品做了一件事」）。
 *
 * 所以本文件第一条断言的**不是**播种成功，而是**「不播种就建不了 Task」这件事有人守着**：
 * 删掉 `ImageSeeder` 的注册（`image.module.ts` 的 providers）⇒ 第一条红。
 */
/**
 * ⚠️ 用 `Pick` 声明**只用到的那几个成员**，而不是 `as unknown as` 双重断言 ——
 * 后者在本仓被 lint 禁掉（「用正当类型收窄替代」），而且它会让替身与真实接口的偏差
 * 静默通过。与 `apps/api/test/unit/error-envelope.filter.spec.ts` 同一手法。
 */
type MinimalRepo = Pick<ImageRepository, 'findByName'>;
type MinimalService = Pick<ImageApplicationService, 'registerImage'>;

function fakeRepo(existing: string | null): MinimalRepo {
  return {
    findByName: vi.fn(async (name: string) =>
      existing !== null && name === existing
        ? await Promise.resolve(
            Image.create({
              id: 'img-1',
              name,
              ownerRef: null,
              isBuiltin: true,
              createdAt: new Date('2026-08-25T00:00:00.000Z'),
            }),
          )
        : null,
    ),
  };
}

function fakeService(behaviour: 'ok' | 'throws' | 'hangs'): MinimalService {
  return {
    registerImage: vi.fn(async () => {
      if (behaviour === 'throws') throw new Error('registry unreachable: getaddrinfo ENOTFOUND');
      // ⚠️ `'hangs'` 与 `'throws'` 是**两件事**：registry 抛错 vs registry 不响应。
      //    前者被 `catch` 接住，后者不会——DNS 黑洞 / 防火墙静默丢包 / 限流后挂起时，
      //    请求一直挂着，`onApplicationBootstrap` 被 Nest await 着，平台起不来。
      if (behaviour === 'hangs') return await new Promise<never>(() => undefined);
      return await Promise.resolve({
        manifest: {
          id: 'm-1',
          digest: `sha256:${'a'.repeat(64)}`,
          validationStatus: 'valid',
        },
        validation: { status: 'valid', errors: [], warnings: [] },
        created: true,
      } as Awaited<ReturnType<ImageApplicationService['registerImage']>>);
    }),
  };
}

/** 单次断言收在这里：构造器要的是完整接口，而替身只实现了用到的两个成员。 */
const seederWith = (repo: MinimalRepo, service: MinimalService): ImageSeeder =>
  new ImageSeeder(repo as ImageRepository, service as ImageApplicationService);

const prevRef = process.env.SANDBOX_DEFAULT_IMAGE;
beforeEach(() => {
  process.env.SANDBOX_DEFAULT_IMAGE = 'ghcr.io/agent-infra/sandbox:latest';
});
afterEach(() => {
  if (prevRef === undefined) delete process.env.SANDBOX_DEFAULT_IMAGE;
  else process.env.SANDBOX_DEFAULT_IMAGE = prevRef;
  vi.restoreAllMocks();
});

describe('ImageSeeder：全新部署自带一张镜像', () => {
  it('空库 ⇒ 播种，且标 isBuiltin —— 否则用户能把平台唯一能跑的镜像删掉', async () => {
    const service = fakeService('ok');
    await seederWith(fakeRepo(null), service).onApplicationBootstrap();

    expect(service.registerImage).toHaveBeenCalledTimes(1);
    // ⚠️ 第二个参数不是可有可无：`isBuiltin` 的唯一效果是 I-IMG-4「不可删除、只可禁用」。
    //    漏了它，[删除] 就会出现在平台自带的那张卡上，点下去平台从此建不出 Task。
    expect(service.registerImage).toHaveBeenCalledWith('ghcr.io/agent-infra/sandbox:latest', {
      builtin: true,
    });
  });

  it('库里已有同名镜像 ⇒ **不触网**：每次重启都发一次 registry 请求是没必要的依赖', async () => {
    const service = fakeService('ok');
    await seederWith(fakeRepo('ghcr.io/agent-infra/sandbox'), service).onApplicationBootstrap();

    expect(service.registerImage).not.toHaveBeenCalled();
  });

  it('⭐ registry 不可达 ⇒ **不抛**，平台照常启动', async () => {
    const seeder = seederWith(fakeRepo(null), fakeService('throws'));
    // ⚠️ 这一条是本文件最要紧的。离线部署、ghcr 限流、内网无出口——任何一种都不该让
    //    平台起不来。起不来是最响的报错，但它报错的对象是错的：离线部署本来就该能起来，
    //    只是建不了 Task，而门口那条 `IMAGE_NOT_REGISTERED` 会把这件事说清楚。
    //
    // MUTATION: 把 `catch` 里改成 rethrow ⇒ 本条红。
    await expect(seeder.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('⭐ 播种失败时的日志必须说得出**正确的**下一步（血统落地后它变了）', async () => {
    // 04 §7 ★血统 ③：以前「去镜像管理注册一张」是可行的出路；现在不是——自定义镜像
    // 必须基于平台预制镜像，而播种失败意味着库里一张预制镜像都没有，任何自定义注册都会
    // 撞上 `INVALID_STATE`「平台还没有可用的预制镜像作为基准」。**日志说错下一步，比不打
    // 日志更贵**：它会把人送去做一件必然失败的事，还让他以为自己做错了。
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await seederWith(fakeRepo(null), fakeService('throws')).onApplicationBootstrap();

    const line = String(warn.mock.calls[0]?.[0] ?? '');
    // MUTATION: 把 message 换回「在镜像管理里注册一张镜像之前建不了 Task」⇒ 本条红。
    expect(line).toContain('SANDBOX_DEFAULT_IMAGE');
    expect(line).toContain('预制镜像');
  });

  it('⭐ registry **不响应** ⇒ 也不阻断启动 —— `catch` 接不住"一直慢"', async () => {
    // ⚠️ 这条与上面「不可达 ⇒ 不抛」看着像，其实是**另一半**，而那一半实测漏过：
    //    2026-08-26 本机，ghcr 解析挂住 ⇒ `access-unlock.e2e-spec.ts` 的 `beforeAll`
    //    （建一次 AppModule）卡满 30s hook 超时、4 条用例全 skip。当时 `catch` 好端端在
    //    那儿——它接得住抛出来的失败，接不住不响应。生产上这就是「服务卡在启动」。
    //
    // MUTATION: 去掉 `withBudget`（直接 `await this.seed(ref)`）⇒ 本条挂满超时后红。
    vi.useFakeTimers();
    try {
      const settled = vi.fn();
      const done = seederWith(fakeRepo(null), fakeService('hangs'))
        .onApplicationBootstrap()
        .then(settled);

      // 预算之内：还在等，符合预期（**先证明它没有立刻放弃**，否则下一条断言
      // 用一个「压根没等过」的实现也能通过）。
      await vi.advanceTimersByTimeAsync(1_000);
      expect(settled).not.toHaveBeenCalled();

      // 预算之外：必须已经放手，且是 resolve 不是 reject（纪律②）。
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(done).resolves.toBeUndefined();
      expect(settled).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⭐ 预算必须明显小于调用方的耐心', async () => {
    // ⚠️ 上一条用假时钟推进，**推多久都能绿**——把预算改成 10 分钟它照样通过。
    //    所以那条证明的是「有预算」，这条证明的是「预算是个有用的数」。
    //    30s 是 vitest 的 hook 超时，也大致是运维盯着 `docker compose up` 的耐心上限；
    //    预算若不明显小于它，这个修复等于没做。
    //
    // MUTATION: `SEED_BUDGET_MS` 改成 60_000 ⇒ 本条红。
    vi.useFakeTimers();
    try {
      const settled = vi.fn();
      seederWith(fakeRepo(null), fakeService('hangs')).onApplicationBootstrap().then(settled);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(
        settled,
        '播种预算超过了 15s —— 调用方（e2e hook / 运维）等不到那时候',
      ).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('镜像名解析不能被端口号骗到（`localhost:5001/x:v1`）', async () => {
    const repo = fakeRepo(null);
    process.env.SANDBOX_DEFAULT_IMAGE = 'localhost:5001/agent-infra/sandbox:v1';
    await seederWith(repo, fakeService('ok')).onApplicationBootstrap();

    // 按名查库时 tag 要去掉，而 `:5001` 那个冒号**不是** tag 分隔符。
    // MUTATION: `stripTag` 改用 `ref.indexOf(':')` ⇒ 查的名字变成 `localhost`，本条红。
    expect(repo.findByName).toHaveBeenCalledWith('localhost:5001/agent-infra/sandbox');
  });
});
