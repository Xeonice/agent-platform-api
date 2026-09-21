import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { builtinImageRefFor } from '@platform/shared-kernel';
import {
  SANDBOX_PROVIDER_REGISTRY,
  IMAGE_FACADE,
  type ImageFacade,
  type ProviderRegistry,
  type ResolvedImageSpec,
  type SandboxHandle,
  type SandboxProvider,
} from '@platform/contracts';

/**
 * auth helper 容器的生命周期（11 §1.1 的「常驻 helper 容器」形态）。
 *
 * ══ 为什么它不是一个 compose 服务 —— 文档写错了，这里记下实测 ══════════════
 *
 * 11 §1.1 原文说「compose 增加一个 `auth-helper` 服务 … 后端经同一套
 * `SandboxProvider.spawn({tty:true})` 在其中起登录命令」。**这两半拼不到一起。**
 *
 * ⛔ 平台在容器里跑进程**根本不走 `docker exec`** —— `docker-container-runtime.ts`
 * 里压根没有 exec 这个方法。它走的是**镜像内的一个 HTTP agent**：
 *
 *     spawn(handle) → AioSandboxAgentClient(agentOrigin(handle), agentAuthToken)
 *                                              ↑                    ↑
 *                               容器地址（按容器名解析）    create() 时平台生成并注入
 *
 * 而那个 token 是 `aio-sandbox.provider.ts` 在 **create() 那一刻**生成、经 env 注进
 * 容器的。compose 建的容器没有经过这一步 ⇒ 平台既不知道 token，容器也不认平台。
 * ⇒ **helper 容器必须由平台通过 provider 创建**，compose 给不了这个前提。
 *
 * ⛔⛔ 同一节还写着 `command: sleep infinity`，那一条更要命：AIO 镜像**自带
 * entrypoint，而那个 entrypoint 正是启动 agent 的东西**（`docker-container-runtime.ts`
 * 的注释已经为沙箱写过这句警告：覆盖它会得到一个「running 但永远连不上」的容器）。
 * 拿 `sleep infinity` 覆盖 = 亲手掐掉唯一的进入通道。⇒ 本实现**不覆盖任何命令**，
 * helper 与任务沙箱用完全一样的启动方式，区别只在不挂卷、配额更小。
 *
 * ══ 为什么重启就重建，而不是接回去 ═════════════════════════════════════════
 * `agentAuthToken` 每次 create 新生成。api 重启后内存里那份就没了，**旧容器认的是
 * 旧 token** ⇒ 接不回去。要接回就得把 token 落库，而那是一份凭证类的值。
 * ⇒ 选更简单也更干净的一条：**开机先按固定名销毁残留的那个，再建一个新的**。
 * 容器名是确定的（`platform-<provider>-<sandboxId>`，见 `aio-sandbox.provider.ts`），
 * 所以「残留」总是找得到，不需要 runtime 层提供 list（它也确实没有）。
 *
 * ⚠️ **创建必须是后台的，⛔ 不能挡住 api 启动。** 首次要拉约 4GB 的镜像；而
 * 一个只用 API Key 的部署、或者一台离线机器，都必须照样能把平台跑起来 ——
 * 拉不动镜像不是「平台坏了」。所以 `onApplicationBootstrap` 只点火不等待，
 * 没就绪时 `require()` 抛错，由上层包成 `PROVIDER_UNAVAILABLE`（24 §「helper 容器缺失」）。
 */
/**
 * `ContainerAuthHelper` 真正需要的那一件事 —— 「给我一个能用的 (provider, handle)」。
 *
 * ⚠️ 收成窄口子不是抽象洁癖：helper 不关心预热、不关心重建、不关心诊断状态，而
 * {@link HelperContainerSession} 这三样都管。让 helper 依赖整个类，测试就得去伪造
 * 一个带私有字段的类实例（只能靠 `as unknown as` 双重断言，而本仓禁止它 ——
 * 禁令的理由正是「逼出正当的类型收窄」）。⇒ 这里就是那个正当的收窄。
 */
export interface HelperContainerAccess {
  require(): Promise<{ provider: SandboxProvider; handle: SandboxHandle }>;
}

@Injectable()
export class HelperContainerSession implements OnApplicationBootstrap, HelperContainerAccess {
  private readonly logger = new Logger('HelperContainerSession');

  /** 固定 id ⇒ 容器名确定 ⇒ 残留总是找得到。⛔ 别改成随机值。 */
  static readonly SANDBOX_ID = 'auth-helper';

  /**
   * helper 不跑用户代码、不编译、不装东西 —— 它只在自己的进程里跑一条登录 CLI。
   * ⚠️ 给得太小会让 CLI 自己 OOM；这是一档「够跑一个 node CLI」的保守值。
   */
  private static readonly QUOTA = { cores: 1, ramMb: 512, diskMb: 2048 };

  private ready: { provider: SandboxProvider; handle: SandboxHandle } | null = null;
  /** 正在创建的那一次 —— 并发的 `require()` 复用它，不会同时建两个。 */
  private inflight: Promise<void> | null = null;
  private lastError: string | null = null;

  constructor(
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
    @Inject(IMAGE_FACADE) private readonly images: ImageFacade,
  ) {}

  onApplicationBootstrap(): void {
    // ⛔ 不 await。见抬头：拉镜像不能挡住启动，失败也不能让平台起不来。
    void this.ensure().catch((e: unknown) => {
      this.logger.warn(`auth helper 预热失败（登录功能将不可用，其余不受影响）：${msgOf(e)}`);
    });
  }

  /** 给诊断项用：不触发创建，只如实报当前状态。 */
  status(): { ready: boolean; starting: boolean; lastError: string | null } {
    return {
      ready: this.ready !== null,
      starting: this.inflight !== null,
      lastError: this.lastError,
    };
  }

  /**
   * 拿一个能用的 helper；没有就现建（首次登录时若预热还没完成，走这条）。
   *
   * ⚠️ 抛出的错会被 `RuntimeApplicationService.beginAuth` 包成 `PROVIDER_UNAVAILABLE`，
   * ⛔ **不许降级到「在任务沙箱里登录」** —— 那会把决策 A 又退回去（05 §2 / 11 §1.1）。
   */
  async require(): Promise<{ provider: SandboxProvider; handle: SandboxHandle }> {
    if (this.ready !== null) return this.ready;
    await this.ensure();
    if (this.ready === null) {
      throw new Error(`auth helper 容器不可用：${this.lastError ?? '未知原因'}`);
    }
    return this.ready;
  }

  private async ensure(): Promise<void> {
    if (this.ready !== null) return;
    // 并发合流：两个请求同时进来只建一次。
    this.inflight ??= this.createOnce().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  private async createOnce(): Promise<void> {
    try {
      const provider = this.providers.get(this.providers.defaultProvider);
      const image = await this.resolveImage(provider.name);

      // ⚠️⚠️ **先 stage 再 create —— `create()` 不会自己拉镜像。**
      // 2026-09-22 真机上就撞在这：镜像只是「注册进平台」而**没下载到本机**，于是
      // `create` 直接回 `No such image: …@sha256:0d89…`。平台的模型一贯是「先 stage
      // 后 create」（向导第 3 步那个【准备镜像】干的就是 stage 这一步），helper 不能
      // 假设别人已经替它做过。
      // ⚠️ `stageImage` 是**可选方法**（没有 capability 位，判据就是这个 typeof），
      //    且契约保证**幂等、已就绪时调也安全** —— 所以不必先问 `imageStaged`。
      // ⚠️ 这一步可能要拉约 4GB，但它跑在后台预热里（见抬头），不挡 api 启动。
      if (typeof provider.stageImage === 'function') {
        this.logger.log(`auth helper：正在准备镜像 ${image.ref}（首次可能要拉约 4GB）`);
        await provider.stageImage(image);
      }

      // 先清残留：api 重启后那个旧容器还在，名字会撞。
      // ⚠️ 用 `destroy` 而不是先 `inspect` 判断 —— 不存在时 destroy 本就该是幂等的，
      //    多一次 inspect 只是多一个会失败的形态。
      await provider
        .destroy({ provider: provider.name, providerSandboxId: HelperContainerSession.SANDBOX_ID })
        .catch(() => undefined);

      const handle = await provider.create({
        sandboxId: HelperContainerSession.SANDBOX_ID,
        quota: HelperContainerSession.QUOTA,
        image,
        // ⛔ **不挂任何卷。** helper 是凭证链路的一部分，不是执行环境（11 §1.1 运行纪律）：
        //    它不该看得见任何工作区，也就不可能把凭证写进某个项目目录。
        env: {},
        labels: { 'platform.role': 'auth-helper' },
      });
      await provider.start(handle);

      this.ready = { provider, handle };
      this.lastError = null;
      this.logger.log(`auth helper 就绪（${provider.name} / ${image.ref}）`);
    } catch (e: unknown) {
      this.lastError = msgOf(e);
      throw e;
    }
  }

  /**
   * helper 用**平台自己的那张预制镜像** —— 与用户任务跑的是同一张。
   *
   * ⚠️ 这不是省事，是 11 §1.1 列的第一条理由：**登录用的 CLI 必须和任务里跑的
   * 同一个版本**。各装各的就是两条独立升级线，漂移之后的症状是「helper 能登录，
   * 但 sandbox 用不了那份凭证」—— 那种 bug 极难查。
   */
  private async resolveImage(providerName: string): Promise<ResolvedImageSpec> {
    const ref = builtinImageRefFor(providerName);
    const registered = await this.images.findRegisteredByRef(ref);
    if (registered === null) {
      throw new Error(`预制镜像 '${ref}' 还没注册进平台 —— 先让开机播种把它登记上`);
    }
    return {
      ref: registered.ref,
      digest: registered.digest,
      ...(registered.entrypoint ? { entrypoint: registered.entrypoint } : {}),
    };
  }
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
