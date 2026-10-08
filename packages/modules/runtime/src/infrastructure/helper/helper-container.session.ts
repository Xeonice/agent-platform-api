import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { builtinImageRefFor } from '@platform/shared-kernel';
import {
  AUTH_HELPER_SANDBOX_ID,
  SANDBOX_PROVIDER_REGISTRY,
  IMAGE_FACADE,
  SandboxProviderError,
  SandboxProviderErrorCode,
  type ImageFacade,
  type ProviderRegistry,
  type ResolvedImageSpec,
  type ResourceQuota,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxRuntimeLifecycleState,
} from '@platform/contracts';
import { HelperUnavailableError } from '../../domain/ports/auth-helper.port';
import { TIMED_OUT, within } from './within';

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
 * ══ 句柄会失效：复用之前先问一次，坏了就重建一次 ═══════════════════════════
 * 内存里那个 ready 句柄此前**从不复核**：box 被删或 VM 被杀之后，每一次登录 / 刷新都撞
 * NOT_FOUND，一直坏到 api 重启 —— 而刷新扫描器连撞 3 次就把凭证判成过期、从此不再自动刷新。
 * 现在三道自愈，都只重建、⛔ 不尝试把旧实例拉起来（旧 rootfs 里可能有刷新时短暂落盘的凭证；
 * boxlite provider 也拒绝对停掉的 helper 做 exec，免得 BoxLite 隐式把它复活）：
 *   ① `require()` 复用前 `inspect` 一次（只读，见 {@link liveness}）；
 *   ② `ContainerAuthHelper` 的命令撞上实例级的 provider 错误 ⇒ 确认之后 {@link invalidate}，重试一次；
 *   ③ 每次创建先按固定名清残留（还在跑的先礼貌停机），start 失败当场停掉并销毁半成品
 *      —— 名字唯一，留着就必然撞名。
 * ⛔ 没有后台定时自愈：没人登录、也没有到期的凭证时，失效的 helper 留到下一次使用才重建。
 *    运维想立刻重建，发起一次帐号登录再取消即可。
 *
 * ⚠️ **创建必须是后台的，⛔ 不能挡住 api 启动。** 首次要拉约 4GB 的镜像；而
 * 一个只用 API Key 的部署、或者一台离线机器，都必须照样能把平台跑起来 ——
 * 拉不动镜像不是「平台坏了」。所以 `onApplicationBootstrap` 只点火不等待，
 * 没就绪时 `require()` 抛错，由上层包成 `PROVIDER_UNAVAILABLE`（24 §「helper 容器缺失」）。
 */
/**
 * `ContainerAuthHelper` 真正需要的那两件事 —— 「给我一个能用的 (provider, handle)」，以及
 * 「你给我的这个用不了」。
 *
 * ⚠️ 收成窄口子不是抽象洁癖：helper 不关心预热、不关心重建、不关心诊断状态，而
 * {@link HelperContainerSession} 这三样都管。让 helper 依赖整个类，测试就得去伪造
 * 一个带私有字段的类实例（只能靠 `as unknown as` 双重断言，而本仓禁止它 ——
 * 禁令的理由正是「逼出正当的类型收窄」）。⇒ 这里就是那个正当的收窄。
 */
export interface HelperContainerAccess {
  require(): Promise<{ provider: SandboxProvider; handle: SandboxHandle }>;
  /**
   * 作废一个用不了的句柄（CAS）：只有它**仍是当前那个**时才清空，下一次 `require()` 重建。
   * ⚠️ 拿旧句柄来作废不会误伤已经重建好的新 helper —— 并发的几个调用方可能同时撞上同一个
   *    坏句柄，只有第一个真正生效，重建经 `inflight` 合流只做一次。
   */
  invalidate(handle: SandboxHandle, reason: string): void;
}

/**
 * helper 的配额 —— 建 box 用它，调度容量里的常驻预留（`PLATFORM_RESERVATIONS`，见
 * `runtime.module.ts`）也用它：两处同源，改这里两边一起变。
 *
 * helper 不跑用户代码、不编译、不装东西 —— 它只在自己的进程里跑一条登录 CLI。
 * ⚠️ 给得太小会让 CLI 自己 OOM；这是一档「够跑一个 node CLI」的保守值。
 */
export const AUTH_HELPER_QUOTA: Readonly<ResourceQuota> = { cores: 1, ramMb: 512, diskMb: 2048 };

/** 诊断项读的那一份：内存状态 + 有句柄时 provider 的一次只读回答。 */
export interface HelperObservation {
  ready: boolean;
  starting: boolean;
  lastError: string | null;
  /** 有句柄、且 provider 答上来了才有。 */
  instanceState?: SandboxRuntimeLifecycleState;
  /** 有句柄时：`true` = 实例已不在运行（下次使用会重建），`false` = 在运行；问不出来 ⇒ 缺席。 */
  stale?: boolean;
  /** 有句柄但问不出来时的原因（超时 / provider 报错）。 */
  probeError?: string;
  /**
   * 没有句柄，是因为上一个实例**被作废了**、还没轮到重建（`lastError` 写着作废原因）——
   * 而不是「建不起来」。两者的下一步不同：前者等下一次使用自动重建，后者要去查镜像 / 运行时。
   */
  awaitingRebuild?: true;
}

type ReadyHelper = { provider: SandboxProvider; handle: SandboxHandle };

/** `inspect` 的三种读法 —— 见 {@link HelperContainerSession.liveness}。 */
type Liveness =
  | { verdict: 'alive'; state: SandboxRuntimeLifecycleState }
  | { verdict: 'gone'; state: SandboxRuntimeLifecycleState; detail: string }
  | { verdict: 'unknown'; detail: string };

/**
 * 开机预热的重试次数与间隔。
 *
 * ⚠️ 覆盖的是两种「等一下就好」的形态：① 与 `ImageSeeder` 的赛跑（秒级）；
 * ② 镜像还在拉（分钟级，`stageImage` 自己会等，所以这里主要是①）。
 * ⛔ 不要调得很大 —— 真正缺镜像的机器不该被无限重试掩盖成「一直在准备中」。
 */
const PREHEAT_ATTEMPTS = 5;
const PREHEAT_RETRY_MS = 3_000;

/**
 * 复核一次存活的预算。
 *
 * ⚠️ boxlite 的 `inspect` 读的是本地状态（实测 0ms），5 秒只给卡住的 provider 兜底；超时
 *    按「问不出来」处理、照旧复用，⛔ 不当成失效 —— 那会因为一次慢查询就把一个好好的
 *    helper force remove 掉。⚠️ 也必须小于诊断给每一项的 10 秒（`observe()` 用同一个数）。
 */
const LIVENESS_TIMEOUT_MS = 5_000;

/**
 * start 失败后、销毁半成品之前礼貌停机的上限 —— 与任务 teardown 的 `stopForTeardown` 同一个数
 * （盖住 BoxLite 10 秒的 guest shutdown 加 2 秒的 SIGTERM→SIGKILL）。超时不等，照删。
 */
const COURTESY_STOP_MS = 20_000;

@Injectable()
export class HelperContainerSession implements OnApplicationBootstrap, HelperContainerAccess {
  private readonly logger = new Logger('HelperContainerSession');

  /**
   * 固定 id ⇒ 容器名确定 ⇒ 残留总是找得到。⛔ 别改成随机值。
   * ⚠️ 值来自 contracts（对账器认的是同一个），发版探针也硬编码了它 —— 见那里的注释。
   */
  static readonly SANDBOX_ID = AUTH_HELPER_SANDBOX_ID;

  private ready: ReadyHelper | null = null;
  /** 正在创建的那一次 —— 并发的 `require()` 复用它，不会同时建两个。 */
  private inflight: Promise<void> | null = null;
  private lastError: string | null = null;
  /** `lastError` 是从哪来的：上一个实例被作废（等下一次使用重建），还是这一次没建起来。 */
  private lastErrorKind: 'invalidated' | 'create-failed' | null = null;
  /**
   * 已经为「问不出死活、照旧复用」记过 warn 的那个实例 —— 同一个实例连续问不出来只记第一次，
   * 一旦问清楚就清掉（不读挂钟做节流，01 §3）。
   */
  private unverifiedWarned: string | null = null;

  constructor(
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
    @Inject(IMAGE_FACADE) private readonly images: ImageFacade,
  ) {}

  onApplicationBootstrap(): void {
    // ⛔ 不 await。见抬头：拉镜像不能挡住启动，失败也不能让平台起不来。
    void this.preheat();
  }

  /**
   * 开机预热 —— **带重试**，⛔ 不是一次不成就永久放弃。
   *
   * ⚠️⚠️ **它必须重试，因为它与 `ImageSeeder` 赛跑,而且真的输过。**
   * 2026-09-22 真机日志（同一秒内）：
   *
   *     17:17:11 WARN HelperContainerSession 预热失败：镜像还没注册进平台
   *     17:17:11 LOG  ImageSeeder            seeded built-in image …sandbox   ← 在我之后
   *
   * Nest 的 `onApplicationBootstrap` **不保证跨模块顺序**,而 `resolveImage` 要查的
   * 正是 seeder 刚登记的那一行。⛔ 不能靠「让 runtime 模块依赖 image 模块」来排序 ——
   * 那是为了一次预热去造一条真实的模块依赖。
   *
   * ⚠️ **输掉这场赛跑的后果不是「慢一点」,是诊断开始撒谎**：第 ⑨ 项会报
   * 「帐号登录暂不可用」,而用户真去点登录时 `require()` 会重试并成功 ——
   * 一个「说不可用但其实可用」的诊断,比没有这一项更坏。
   *
   * ⚠️ 只重试**开机预热**这一条路。用户点登录走的 `require()` 仍然一次定生死:
   * 那时人在等,快速失败并说清原因,好过静默重试一分钟。
   */
  private async preheat(): Promise<void> {
    for (let attempt = 1; attempt <= PREHEAT_ATTEMPTS; attempt += 1) {
      try {
        await this.ensure();
        return;
      } catch (e: unknown) {
        const last = attempt === PREHEAT_ATTEMPTS;
        this.logger.warn(
          `auth helper 预热第 ${String(attempt)}/${String(PREHEAT_ATTEMPTS)} 次未成：${msgOf(e)}` +
            (last ? '（登录功能将不可用，其余不受影响；用户点登录时仍会再试一次）' : '，稍后重试'),
        );
        if (last) return;
        await new Promise((r) => setTimeout(r, PREHEAT_RETRY_MS));
      }
    }
  }

  /**
   * 只看内存的同步快照，不触发创建。
   * ⚠️ 它**不知道实例还活不活着** —— 诊断要用 {@link observe}，否则 helper 死掉之后仍会报「可用」。
   */
  status(): { ready: boolean; starting: boolean; lastError: string | null } {
    return {
      ready: this.ready !== null,
      starting: this.inflight !== null,
      lastError: this.lastError,
    };
  }

  /**
   * 给诊断项用：内存状态 + 有句柄时问 provider 一次（`inspect`）。
   *
   * ⛔ **只读**：不建 box、不 exec、不作废句柄 —— 让「运行诊断」顺手去拉一张 4GB 的镜像或
   *    重建 helper，会把一次「看看哪儿坏了」变成一次带副作用的长操作。失效的句柄留给下一次
   *    真正的使用去重建。⚠️ 不抛：`DiagnoseCheck.run()` 的契约不许抛。
   */
  async observe(): Promise<HelperObservation> {
    const base = this.status();
    const cur = this.ready;
    if (cur === null) {
      return !base.starting && this.lastErrorKind === 'invalidated'
        ? { ...base, awaitingRebuild: true }
        : base;
    }
    const live = await this.liveness(cur);
    if (live.verdict === 'unknown') return { ...base, probeError: live.detail };
    return { ...base, instanceState: live.state, stale: live.verdict === 'gone' };
  }

  /**
   * 拿一个能用的 helper；没有就现建（首次登录时若预热还没完成，走这条）。
   *
   * ⚠️ 复用 ready 句柄之前先 {@link liveness} 一次：确认失效才作废并重建，**每次调用最多
   *    重建一次**，⛔ 不在这里循环重试（人在等，快速失败并说清原因）。
   * ⚠️ 抛出的是 {@link HelperUnavailableError}：`RuntimeApplicationService.beginAuth` 把它包成
   *    `PROVIDER_UNAVAILABLE`，刷新扫描器据它判断「这不是凭证的错」。
   *    ⛔ **不许降级到「在任务沙箱里登录」** —— 那会把决策 A 又退回去（05 §2 / 11 §1.1）。
   */
  async require(): Promise<{ provider: SandboxProvider; handle: SandboxHandle }> {
    const cur = this.ready;
    if (cur !== null) {
      const live = await this.liveness(cur);
      if (live.verdict === 'gone') {
        this.invalidate(cur.handle, `存活复核：${live.detail}`);
      } else if (this.ready === cur) {
        // 问不出来按存活处理；但若复核期间别人已经作废 / 换掉了它，就落到下面去拿当前那个。
        this.noteUnverified(cur, live);
        return cur;
      }
    }
    // ⚠️ **必须吞掉 `ensure()` 的原始错误再统一改写。** 此前这里是裸 `await`,
    //    于是底层那句（「预制镜像还没注册进平台」之类）会**直接穿透出去**,
    //    下面这句统一文案根本到不了 —— 上层 `beginAuth` 认的是这一句才包成
    //    `PROVIDER_UNAVAILABLE`,穿透的那个会被当成未知错误变成哑巴 500。
    //    ⚠️ 原因没有丢:它在 `lastError` 里,被下面这句带上。
    await this.ensure().catch(() => undefined);
    if (this.ready === null) {
      throw new HelperUnavailableError(`auth helper 容器不可用：${this.lastError ?? '未知原因'}`);
    }
    return this.ready;
  }

  /**
   * CAS 作废（语义见 {@link HelperContainerAccess.invalidate}）。只清内存、不碰实例 ——
   * 删掉旧实例是重建时 `destroyBySandboxId` 的事。
   * ⚠️ `reason` 要写明**是谁、在做什么时**发现的（存活复核 / 建 HOME / 起登录命令…）——
   *    事后还原「box id 为什么变了」只能靠这一行。
   */
  invalidate(handle: SandboxHandle, reason: string): void {
    const cur = this.ready;
    if (
      cur === null ||
      cur.handle.provider !== handle.provider ||
      cur.handle.providerSandboxId !== handle.providerSandboxId
    ) {
      return;
    }
    this.ready = null;
    this.lastError = `上一个实例 ${handle.providerSandboxId} 已失效：${reason}`;
    this.lastErrorKind = 'invalidated';
    this.logger.warn(`auth helper ${handle.providerSandboxId} 已失效（${reason}），下次使用时重建`);
  }

  /**
   * 复核结论是「问不出来」而照旧复用时留一条 warn —— 此前这一支完全静默，事后看不出
   * 「为什么复用了一个查不清状态的实例」。同一个实例只记第一次，问清楚之后再重新计。
   * ⚠️ 照旧复用的残余风险已由 provider 兜住：实例若其实已停，boxlite 拒绝对它 exec
   *    （INVALID_STATE），`ContainerAuthHelper` 据此作废重建，⛔ 不会把旧实例隐式拉起来。
   */
  private noteUnverified(cur: ReadyHelper, live: Liveness): void {
    const id = cur.handle.providerSandboxId;
    if (live.verdict !== 'unknown') {
      this.unverifiedWarned = null;
      return;
    }
    if (this.unverifiedWarned === id) return;
    this.unverifiedWarned = id;
    this.logger.warn(
      `auth helper ${id} 这次没能确认死活（${live.detail}），照旧复用；真正执行时若失败会作废重建`,
    );
  }

  /**
   * 这个句柄背后的实例还在不在。**只调 `inspect`**，三种读法：
   *   · `instance_running` ⇒ 存活；
   *   · 答出来但不是 running（被删 ⇒ `instance_missing`、退出、崩溃…），或抛 `NOT_FOUND` ⇒ 失效；
   *   · 其余异常或超时 ⇒ 问不出来，调用方按存活处理 —— 误判失效的代价是 force remove 一个
   *     好好的 helper，正在进行的刷新跟着失败一次。
   *
   * ⛔ **不要用 exec 或 metrics 探活。** boxlite 的 `create` 是懒的，第一次 exec 才起 VM；
   *    `metrics()` 会隐式启动已停止的 VM。`inspect` 读的是 `getInfo`（本地状态），只在
   *    running 时才碰 metrics（586ce08）—— 这是唯一不改变实例状态的一问。
   * ⚠️ 「记录还是 running、VM 已经被杀」：BoxLite 0.9.7 不配 health check 时没有退出监视，
   *    `kill -9` 之后 `getInfo` 照报 running。boxlite 的 `inspect` 因此对 running 的记录再按
   *    `shim.pid` + `/proc` 核一次 shim 进程（只读，见 provider 的 `boxlite-shim-liveness.ts`），
   *    核出已死就报 `instance_dead` ⇒ 这里读作失效。没有 procfs 的平台（macOS）核不了，
   *    那一种仍由 `ContainerAuthHelper` 的「命令撞上实例级错误就作废重建」兜住。
   */
  private async liveness(cur: ReadyHelper): Promise<Liveness> {
    try {
      const status = await within(cur.provider.inspect(cur.handle), LIVENESS_TIMEOUT_MS);
      if (status === TIMED_OUT) {
        return {
          verdict: 'unknown',
          detail: `${String(LIVENESS_TIMEOUT_MS / 1000)} 秒内没有答复`,
        };
      }
      return status.lifecycleState === 'instance_running'
        ? { verdict: 'alive', state: status.lifecycleState }
        : {
            verdict: 'gone',
            state: status.lifecycleState,
            detail: `实例已不在运行（${status.lifecycleState}）`,
          };
    } catch (e: unknown) {
      if (e instanceof SandboxProviderError && e.code === SandboxProviderErrorCode.NOT_FOUND) {
        return {
          verdict: 'gone',
          state: 'instance_missing',
          detail: `实例已不存在（${e.message}）`,
        };
      }
      return { verdict: 'unknown', detail: msgOf(e) };
    }
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

      // ① 先清残留：api 重启后、或上一个实例失效后，那个旧实例还在，名字会撞。
      //
      // ⚠️ **排在最前**，在 `resolveImage` / `stageImage` 之前：镜像还没注册（与 `ImageSeeder`
      //    抢先后）或者拉不下来时，旧 helper 也照样被清掉 —— 否则它会一直挂在那里，带着
      //    shim.pid 的话发版探针就 fail-closed。也因此不再依赖开机对账和模块顺序。
      //
      // ⚠️⚠️ **这里此前是错的，而且从来没生效过**（2026-09-22 真机撞出来）：
      // 原本传的是 `providerSandboxId: SANDBOX_ID`，而 aio/docker 的
      // `providerSandboxId` 是**容器 ID**，容器名却是 `platform-aio-auth-helper`。
      // ⇒ destroy 404（被 `.catch` 吞掉）⇒ create 撞
      //   `409 Conflict: container name … is already in use`。
      // ⛔ 修法**不是**在这里拼 `platform-<provider>-<sandboxId>`：那是 provider 的
      // 私有命名规则，抄一份出来就是这个仓反复警告的那种「两处各有一份真相」。
      // ⇒ 走契约的 `destroyBySandboxId`，命名规则留在 provider 家里（aio 与 boxlite 都实现了）。
      //
      // ⚠️ 清不掉只记 warn、照常往下建 —— 真撞名时 create 会如实报出来；⛔ 不再静默吞掉。
      // ⚠️ 没有这只手的 provider ⇒ 跳过清理。降级是明确的：create 会撞名字冲突并
      //    如实报出来，⛔ 而不是静默出错。
      // ⚠️ 运行期重建时旧实例可能还在跑（被作废不等于已经死了）：boxlite 的实现先礼貌停机
      //    再 force remove，真删掉了会在 provider 日志里留一行 —— 见它的 `destroyBySandboxId`。
      if (typeof provider.destroyBySandboxId === 'function') {
        await provider
          .destroyBySandboxId(HelperContainerSession.SANDBOX_ID)
          .catch((e: unknown) => this.logger.warn(`auth helper 清残留失败：${msgOf(e)}`));
      }

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

      const handle = await provider.create({
        sandboxId: HelperContainerSession.SANDBOX_ID,
        quota: AUTH_HELPER_QUOTA,
        image,
        // ⛔ **不挂任何卷。** helper 是凭证链路的一部分，不是执行环境（11 §1.1 运行纪律）：
        //    它不该看得见任何工作区，也就不可能把凭证写进某个项目目录。
        env: {},
        labels: { 'platform.role': 'auth-helper' },
      });
      try {
        await provider.start(handle);
      } catch (e: unknown) {
        // ② start 失败 ⇒ **当场销毁半成品**。名字是唯一的：留着它，本进程之后的每一次重试
        //    （预热的 5 次、用户点登录）都撞名，要等到下次启动才被清掉。
        await this.discardHalfBuilt(provider, handle);
        throw e;
      }

      this.ready = { provider, handle };
      this.lastError = null;
      this.lastErrorKind = null;
      this.logger.log(
        `auth helper 就绪（${provider.name} / ${image.ref} / ${handle.providerSandboxId}）`,
      );
    } catch (e: unknown) {
      this.lastError = msgOf(e);
      this.lastErrorKind = 'create-failed';
      throw e;
    }
  }

  /**
   * start 没成的半成品：**先礼貌停机，再销毁**（与任务 teardown 的「先 stop 再 destroy」同一条
   * 纪律）。它可能已经起了 VM、只是没在预算内接受 exec；BoxLite 的 force remove 只信号外层
   * 进程，内层的 shim 与 VM 要靠 box 自己的 cgroup 兜底，而 helper 恰好是每个容器里第一个、
   * 最可能没有这个兜底的 box。停机限时、失败照删 —— 停机是礼貌，删除才是权威。⛔ 从不抛。
   */
  private async discardHalfBuilt(provider: SandboxProvider, handle: SandboxHandle): Promise<void> {
    const id = handle.providerSandboxId;
    const stopped = await within(
      provider.stop(handle).then(
        () => null,
        (e: unknown) => msgOf(e),
      ),
      COURTESY_STOP_MS,
    );
    if (stopped === TIMED_OUT) {
      this.logger.warn(
        `auth helper 半成品 ${id} 在 ${String(COURTESY_STOP_MS / 1000)} 秒内没停下，直接销毁`,
      );
    } else if (stopped !== null) {
      this.logger.warn(`auth helper 半成品 ${id} 停机失败（${stopped}），直接销毁`);
    }
    await provider
      .destroy(handle)
      .catch((d: unknown) => this.logger.warn(`auth helper 半成品 ${id} 销毁失败：${msgOf(d)}`));
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
