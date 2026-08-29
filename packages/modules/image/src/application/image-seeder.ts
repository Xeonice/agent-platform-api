import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { IMAGE_REPOSITORY } from '../domain/repositories/image.repository';
import type { ImageRepository } from '../domain/repositories/image.repository';
import { builtinImageRefs } from '@platform/shared-kernel';
import { SANDBOX_PROVIDER_REGISTRY, type ProviderRegistry } from '@platform/contracts';
import { ImageApplicationService } from './image-application.service';

/**
 * 平台自带镜像的**开机播种**。
 *
 * ── 它修的是什么（一个真的把平台变成不可用的缺口）────────────────────────────
 * 镜像切片落地后，建 Task 的门口改成「只接受注册过、解析出 digest 的镜像」
 * （`ImageFacade.resolveForTask`，04 §7 时刻③）。这一步是对的——它是「跟 digest
 * 不跟 tag」那条裁决的落点。但它有一个没人注意到的后果：
 *
 *   **全新部署的 `images` 表是空的 ⇒ 第一个 Task 就被门口拒。**
 *
 * ⚠️ 而 e2e 全绿，因为 **11 个 e2e 文件都调用了测试专用的 `registerDefaultImage(app)`**
 * ——测试自己把种子播了，产品没有。这正是本仓反复抓到的形态
 * （[LIVE-RUN-FINDINGS](../../../../../docs/LIVE-RUN-FINDINGS.md) 共性 2）：
 * **脚手架替产品做了一件事，于是缺口在测试里不可见。**
 *
 * ── 为什么是「开机解析」而不是「迁移里写死 digest」──────────────────────────
 * 写死 digest 需要在发布流程里对那张镜像真跑一次 validate 并把结论固化。今天没有
 * 发布流程，硬编码一个 digest **就是 `'sha256:unresolved'` 换个马甲**——而我们刚花
 * 一整轮把那个假值清掉（04 §7 ★）。
 *
 * 开机解析的代价比看上去小得多：`resolve()` **只取 manifest + config blob，零字节层
 * 下载**（04 §7 ★，`oci-image-spec.provider.ts` 同注）。3.3GB 那次拉取发生在
 * `provider.create()`，按需，与本类无关。所以这是两三个 HTTP 请求，不是一次下载。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────────
 * ① **先查库，再触网**：已经有这张镜像就直接返回，不让每次重启都依赖 registry。
 * ② **失败不阻断启动**：离线部署、registry 不可达、ghcr 限流——任何一种都不该让平台
 *    起不来。失败时打一条**说得出下一步**的日志，然后把话语权交给门口那条
 *    `IMAGE_NOT_REGISTERED`（它会告诉用户去镜像管理注册一张）。
 *    ⚠️ 这是「少报是降级，多报是撒谎」：起不来是最响的报错，但它报错的对象错了——
 *    离线部署本来就该能起来，只是建不了 Task。
 *    ⚠️ **`catch` 只是这条纪律的一半**：它接得住**抛出来**的失败，接不住**一直慢**。
 *    见下面 `SEED_BUDGET_MS`——那半边是实测漏掉过的。
 * ③ **标 `isBuiltin: true`**：I-IMG-4 让它不可删除、只可禁用。用户误删这一张，
 *    平台就从此建不出 Task —— 而删除按钮本身不会告诉他这件事。
 */
/**
 * 播种的**总预算**——纪律② 缺掉的那一半。
 *
 * ⚠️ `catch` 接得住 registry **抛错**（ENOTFOUND、401、404），接不住它**不响应**：
 * DNS 黑洞、防火墙静默丢包、限流后挂起——这些情况下请求会一直挂着，而
 * `onApplicationBootstrap` 正被 Nest `await` 着，于是**整个平台起不来**。
 * 那恰恰是纪律② 说不该发生的事，只是走了另一条路进来。
 *
 * ⚠️ 这不是假想：2026-08-26 本机实测，`ghcr.io/agent-infra/sandbox:latest` 解析挂住，
 * `access-unlock.e2e-spec.ts` 的 `beforeAll`（建一次 AppModule）**卡满 30s hook 超时**，
 * 4 条用例全部 skip。把默认镜像换成一个立刻失败的坐标后，同一份代码 964ms 全绿——
 * 差别不在被测代码里，在**平台起不起得来**。生产上这就是「服务卡在启动」。
 *
 * ⚠️ 预算必须**明显小于**调用方的耐心。上面那条 e2e hook 是 30s；真正的部署里
 * 是运维盯着 `docker compose up` 的耐心。10s 够两三个 HTTP 往返，又不至于让人以为挂了。
 */
const SEED_BUDGET_MS = 10_000;

@Injectable()
export class ImageSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger('ImageSeeder');

  constructor(
    @Inject(IMAGE_REPOSITORY) private readonly images: ImageRepository,
    private readonly service: ImageApplicationService,
    /**
     * ⚠️ 播种要种的是**每一档的**预制镜像（ADR 决策 C），而「有哪些档」只有 provider
     * 注册表知道。硬写 `['aio','boxlite']` 会让第三方注册进来的 provider 永远没有种子，
     * 而那正是 §8 扩展点承诺过可以做的事。
     */
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // ⚠️ **去重后逐张种**：单档部署（两档指向同一张）这里恒为 1 张，与搬家前一字不差。
    // 逐张各自 try/catch，因为一张种不上不该让另一张也不种——两档是独立的部署形态，
    // 一台 Linux 机器上 boxlite 那张拉不下来，不该连带把 aio 也废掉。
    for (const ref of builtinImageRefs(this.providers.list().map((p) => p.name))) {
      await this.seedOne(ref);
    }
  }

  private async seedOne(ref: string): Promise<void> {
    try {
      await withBudget(this.seed(ref), ref);
    } catch (e) {
      // 刻意不 rethrow —— 见类注释纪律②。
      //
      // ⚠️ 这条日志的下一步在 2026-08「血统验证制」之后**变了**（04 §7 ★血统 ③）。
      // 以前它说「去镜像管理注册一张」就行；现在**不行**——自定义镜像必须基于平台预制
      // 镜像，而这里失败意味着库里一张预制镜像都没有，于是任何自定义注册都会撞上
      // `INVALID_STATE`「平台还没有可用的预制镜像作为基准」。真正的下一步是**把这一张
      // 修好**。日志说错下一步，比不打日志更贵。
      this.logger.warn(
        `built-in image ${ref} could not be seeded (${(e as Error).message}). ` +
          '平台已正常启动，但**建不了 Task，也注册不了自定义镜像**——' +
          '自定义镜像必须基于平台预制镜像，而平台现在一张预制镜像都没有。' +
          `下一步是修好这一张：把 SANDBOX_DEFAULT_IMAGE 指向平台预制镜像` +
          '（构建脚本在 api/images/platform-sandbox），离线部署把它推到内网 registry 后再指过去。',
      );
    }
  }

  private async seed(ref: string): Promise<void> {
    if (await this.alreadySeeded(ref)) return;
    const result = await this.service.registerImage(ref, { builtin: true });
    this.logger.log(
      `seeded built-in image ${ref} → ${result.manifest.digest} (${result.manifest.validationStatus})`,
    );
  }

  /**
   * ⚠️ 按**镜像名**查，不按完整 ref 查。`ghcr.io/x/y:latest` 与 `ghcr.io/x/y:v2` 是
   * 同一个 `images` 行的两个 manifest；用户手动注册过任一版本之后，播种就不该再插手
   * ——那是他的目录，不是平台的。
   */
  private async alreadySeeded(ref: string): Promise<boolean> {
    const name = ref.includes('@') ? ref.slice(0, ref.indexOf('@')) : stripTag(ref);
    return (await this.images.findByName(name)) !== null;
  }
}

/**
 * 在预算内等 `work`，超时就当作一次失败（与 registry 抛错走同一条 `catch`——语义相同：
 * **这次没播成种**）。
 *
 * ⚠️ 超时只是**不再等**，底层那次 HTTP 仍在后台跑完。这在开机场景是可接受的（进程照常
 * 服务，请求自己会结束），但有两个坑必须处理，否则「修好启动」会换来别的毛病：
 *   ① 输掉的 `work` 稍后 reject ⇒ **unhandled rejection**（Node 22 默认让进程退出）。
 *      所以给它挂一个空 `catch` 标记为已处理——注意那是**另一个** promise，
 *      race 拿到的仍是原始 `work`，真实错误照样传得出来。
 *   ② 计时器会**让 Node 进程活着等它**。`unref()` 之后它不再阻止退出；
 *      `clearTimeout` 覆盖正常路径。少任何一条，短命进程（CLI、测试）就会莫名多挂 10 秒。
 */
function withBudget<T>(work: Promise<T>, ref: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`resolving ${ref} exceeded the ${String(SEED_BUDGET_MS)}ms seed budget`)),
      SEED_BUDGET_MS,
    );
    timer.unref();
  });
  work.catch(() => undefined);
  return Promise.race([work, budget]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** 仓库坐标里去掉 tag —— 冒号可能是端口（`localhost:5001/x`），只认最后一段里的。 */
function stripTag(ref: string): string {
  const lastSlash = ref.lastIndexOf('/');
  const colon = ref.indexOf(':', lastSlash + 1);
  return colon < 0 ? ref : ref.slice(0, colon);
}
