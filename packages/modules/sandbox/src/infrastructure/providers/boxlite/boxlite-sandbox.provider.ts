import { createServer, type Server } from 'node:net';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  isOciDigest,
  isPlatformOwnedSandboxId,
  parseImageRef,
  pinnedImageRef,
  SandboxProviderError,
  SandboxProviderErrorCode,
  type ProcessSpec,
  type ProcessStream,
  type SandboxFiles,
  type SandboxHandle,
  type SandboxJobs,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SandboxProviderContext,
  type SandboxRuntimeLifecycleState,
  type SandboxRuntimeStatus,
  type ResolvedImageSpec,
} from '@platform/contracts';
import { CLOCK } from '@platform/shared-kernel';
import type { Clock } from '@platform/shared-kernel';
import {
  getSharedBoxliteRuntime,
  type BoxliteBox,
  type BoxliteRuntime,
  boxliteHome,
} from './boxlite-runtime';
import { boxliteNamePrefix } from '../../reconcile/instance-id';
import { spawnNative } from './boxlite-process.stream';
import { BoxliteSandboxFiles } from './boxlite-files';
import { BoxliteSandboxJobs } from './boxlite-jobs';
import { withClosedGatewayEnv } from './boxlite-exposed-port';
import { runGuestScript } from './boxlite-guest-shell';
import { imageExposedPorts, imageStageProgress, isImageStaged } from './boxlite-image-store';
import { readBoxliteHealth } from './boxlite-health';
import { shimLiveness } from './boxlite-shim-liveness';

/**
 * `boxlite` —— 微 VM provider（04 §2.1、SANDBOX-RUNTIME-DECISIONS 决策 B）。
 *
 * **控制面** = BoxLite 微 VM SDK（`@boxlite-ai/boxlite`）：每个 Box 是一台**独立内核**
 * 的微 VM（macOS 上走 Apple Hypervisor.framework），不是 docker 容器——这是强隔离档，
 * 不是一个标签。
 *
 * **数据面** = **BoxLite native `Box.exec`**（决策 A 修订，2026-08-26）。
 *
 * ══ 这里曾经是什么，以及为什么换掉 ══════════════════════════════════════════
 * 上一版的数据面是「复用 aio 的 `AioSandboxAgentClient`，经端口转发去打微 VM 里那个
 * `:8080` 的 HTTP agent」，理由写在旧注释里，很诚实：*aio 和 boxlite 运行同一个镜像，
 * 因此是同一个 agent*。⚠️ **「两个 provider 跑同一个镜像」是当前配置的巧合，不是契约
 * 保证的性质**，代价是 boxlite 的可用性挂在第三方镜像里的一个 python 服务上。
 *
 * 实测（同一个 box、同一条命令）：
 *
 * | | 沙箱内 API `POST /v1/bash/exec` | native `Box.exec` |
 * |---|---|---|
 * | `echo hi` | 200 | `exit=0`，103ms |
 * | **`codex --version`** | **70ms → HTTP 500，agent 此后永久挂死** | **`exit=0`，18.6s，拿到版本号** |
 * | 挂掉之后再来一条 `echo` | 500（整个沙箱废掉） | `exit=0`，82ms |
 *
 * 第三行最说明问题：**那个 box 的 agent 早已挂死，native exec 照常干活**。
 * 被否掉的假设（内存 / PATH / 镜像 / rootfs）都记在 ADR 里，别重走。
 *
 * ⇒ 本文件与本目录**不再 import `../aio/` 的任何东西**：没有 agent client、没有
 * `waitForAgent`、没有端口转发、没有 token 注入、没有 `assertAgentRejectsAnonymous`，
 * `providerState` 因此变成**空**。两档的一致性由契约测试
 * `runSandboxProviderContractTests` 保证，**不再由共享实现保证**——共享实现保证的是
 * 「两边一样」，可一旦那份实现对某个 provider 不适用，「一样」就变成**一起错**。
 *
 * ⚠️ 唯一残留的、与那个 agent 有关的动作是 `withClosedGatewayEnv`，它**不是数据面**：
 * 镜像若 `EXPOSE` 了端口（AIO 的 `:8080`），BoxLite 会把它自动发布到宿主通配地址且关不掉，
 * 所以那扇门必须上一把没人有钥匙的锁。镜像没声明端口时（平台自己的 platform-boxlite），
 * `create` 不传映射，什么都不发布。整段论证与实测见 `boxlite-exposed-port.ts`。
 *
 * 镜像经**本地 registry 中转**拉取（ADR 工程注记：BoxLite 自己的 image store 不支持
 * 断点续传，大镜像要经 `localhost:5001` 中转）；`imageRegistries` 里保留 `docker.io`，
 * 否则连微 VM 的 bootstrap base（`debian:bookworm-slim`）都拉不到。
 */
@Injectable()
export class BoxliteSandboxProvider implements SandboxProvider {
  readonly name = 'boxlite';
  private readonly logger = new Logger('BoxliteSandboxProvider');

  /**
   * ⚠️ **`@Optional()` 且只用来盖采样时刻。** 基础设施层禁 `new Date()`（01 §3），而
   * `HealthStatus.lastCheckedAt` 是必填 —— BoxLite 自己报了 `lastCheck` 时用它的，
   * 没报时才需要一个「我们什么时候问的」。DI 里 `CLOCK` 永远在（`PlatformModule`
   * 是 `@Global`）；直接 `new` 出来的（单测/契约测试）没有 clock，那时**两个来源
   * 都没有 ⇒ 整个 `health` 字段缺席**，而不是编一个时刻出来。
   */
  constructor(@Optional() @Inject(CLOCK) private readonly clock?: Clock) {}
  readonly capabilities: SandboxProviderCapabilities = {
    spawnTty: true,
    volumeMount: true,
    updateResources: false,
    pauseResume: false,
    /**
     * ⚠️ **SDK 有完整快照 API（`box.snapshot.create/list/get/remove/restore`），这一位
     * 却仍然是 `false`——这是故意的，不是漏改。**
     *
     * `SandboxProvider` 契约上**没有任何快照方法**：能力位与「平台的一条分支」是
     * 一一对应的（04 §2.5 的准入规则，`networkPolicy`/`gpuAllocation` 就是这么被删掉
     * 的），而这一位今天唯一的读者是 `create({ require: { snapshot: true } })` 的
     * 创建前静态校验。把它翻成 `true`，效果是**放行一个平台随后无法兑现的请求**：
     * 用户说「我要能快照的沙箱」，我们答应了，然后没有任何 API 能让他快照。
     * 那比诚实地拒绝更糟。
     *
     * ⇒ 先加方法，再改这一位。顺序反过来就是给自己发一张空头支票。
     */
    snapshot: false,
    /**
     * ⚠️ **2026-08-29 从 `true` 改成 `false`：它一直是谎报。** 契约上 `watchEvents?()`
     * 是一个可选方法，返回 `AsyncIterable<ProviderEvent>`；这个 provider **从来没有
     * 实现过它**（aio 也没有）。两边同时错了这么久，是因为在 CAP-03 之前**没有任何
     * 东西要求任何一位兑现**。
     *
     * 与上面 `snapshot` 那段是同一条纪律：**先加方法，再改这一位**。翻成 `true` 的效果
     * 是放行一个平台随后无法兑现的请求，那比诚实地拒绝更糟。
     */
    watchEvents: false,
    headlessTask: true,
  };

  /**
   * 两个可选面（04 §2.6）。它们和 `spawn` 一样只需要一件事：**把 handle 变成一个当下
   * 可用的 Box**。⚠️ 每次都重新 `runtime.get(id)`，绝不缓存 Box 对象——实测
   * `box.stop()` 之后旧句柄会抛 `Handle invalidated after stop()`，而
   * `stopped → starting` 复用是常规路径（03 §4）。
   */
  readonly jobs: SandboxJobs = new BoxliteSandboxJobs(this.name, (handle) =>
    this.requireBox(handle),
  );
  readonly files: SandboxFiles = new BoxliteSandboxFiles(this.name, (handle) =>
    this.requireBox(handle),
  );

  /** One shared BoxLite runtime per OS process (BoxLite one-runtime-per-home lock). */
  private getRuntime(): Promise<BoxliteRuntime> {
    return getSharedBoxliteRuntime();
  }

  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    return this.guard(async () => {
      const runtime = await this.getRuntime();
      const ports = await this.publishedPortsFor(ctx.image);
      const box = await runtime.create(
        {
          // 04 §7 时刻④: pull by `ref@digest`, not by tag. Steps ①②③ freeze a
          // coordinate into the database; if the string handed to the runtime here is
          // still a tag, all three were bookkeeping. `pinnedImageRef` degrades to the
          // bare tag when the spec carries no real digest (a pre-slice sandbox row).
          image: pinnedImageRef(ctx.image),
          memoryMib: ctx.quota.ramMb,
          cpus: ctx.quota.cores,
          autoRemove: false,
          // detached: the micro-VM SURVIVES the backend process exiting — parity with
          // aio's docker container. 实测：另起一个进程只凭 box id `runtime.get()` 就能
          // 接回去并 exec 成功，`stop()→start()` 之后 rootfs 内容还在。
          // ⇒ 这也是 `providerState` 能空掉的原因：native 通道没有「地址」这回事，
          //   不像沙箱内 agent 那样要记住转发端口和 bearer token。
          detach: true,
          // 见 `boxlite-exposed-port.ts`：这不是数据面，是给镜像自动发布出去的端口
          // 上一把没人有钥匙的锁（镜像没有那个网关时它只是一个没人读的环境变量）。
          env: Object.entries(withClosedGatewayEnv(ctx.env)).map(([key, value]) => ({
            key,
            value,
          })),
          volumes: (ctx.volumes ?? []).map((v) => ({
            hostPath: v.source,
            guestPath: v.target,
            readOnly: v.mode === 'ro',
          })),
          // ⚠️ **映射只在镜像真的声明了端口时才给**，规则见 `publishedPortsFor`。
          // ⛔ 不要改回「无条件给 8080 一个随机端口」：镜像没有 EXPOSE 时，正是那一条映射
          //    让每个 box 都在宿主通配地址上多了一个监听（BoxLite 忽略 hostIp）。
          ...(ports.length > 0 ? { ports } : {}),
        },
        this.boxName(ctx.sandboxId),
      );
      // providerState 为空：native 通道要的全部信息就是 box id 本身。
      return { provider: this.name, providerSandboxId: box.id };
    });
  }

  /**
   * 这个镜像的 box 要给 BoxLite 哪些端口映射 —— **只为让自动发布挪到唯一端口**，不是数据面。
   *
   * BoxLite 0.9.7 的规则（实测 + 读过源码 `vmm_spawn.rs::build_network_config`）：镜像
   * config 里声明的 **tcp** 端口一律自动发布，宿主端口默认等于客体端口；为某个客体端口给一条
   * 映射只能改宿主那一侧的号，关不掉发布；hostIp 与 protocol 都被忽略 —— 每条映射都是
   * `0.0.0.0:<hostPort>` 上的一个 TCP 监听。于是按镜像自己的声明分三种情况：
   *
   *   · 没声明（`[]`）—— 不给映射，BoxLite 什么都不发布。平台的 platform-boxlite 镜像与
   *     auth helper 都走这一支：⇒ 宿主上不再有它们的通配监听。
   *   · 声明了 —— 每个 tcp 端口各挪到一个**互不相同**的空闲宿主端口，多个 box 才能共存
   *     （不给映射时第二个 box 撞固定端口起不来：`gvproxy_create failed: … bind: address
   *     already in use`，本仓 e2e 真的红过）。⚠️ 随机端口**不降低暴露**，只避免冲突。
   *     ⛔ udp 端口不映射：BoxLite 不自动发布 udp，而给它一条映射反倒会多出一个 TCP 监听。
   *   · 读不到（`null`）—— **不发布**并记 warn。镜像若其实声明了端口，BoxLite 会按原号发布，
   *     同一镜像的第二个 box 会撞端口**显式失败**；反过来猜「有」就是给每个 box 白开一个
   *     通配监听。安全优先。
   *
   * ⚠️ 刻意**不在这里 `images.pull`**：那会把冷拉从 starting 挪进 creating，向导那条
   *    「首次要拉镜像」的提示（`imageStaged`）就永远答「已在本机」了。镜像不在库里 ⇒ 读不到。
   * ⚠️ 端口号**不落库**：没有任何东西会去连它（数据面全在 native 那侧），所以它是一次性的、
   *    不需要跨重启还原；已经建好的 box 的映射写在 BoxLite 自己的 box_config 里，start 原样复用。
   */
  private async publishedPortsFor(
    image: ResolvedImageSpec,
  ): Promise<{ hostPort: number; guestPort: number }[]> {
    const ref = pinnedImageRef(image);
    const digest = parseImageRef(ref).digest;
    const exposed =
      digest === undefined || !isOciDigest(digest)
        ? null
        : await imageExposedPorts(
            boxliteHome(),
            digest,
            // 架构名映射照 `stageImage` 那处既有写法（OCI 用 `amd64`，Node 用 `x64`）。
            process.arch === 'arm64' ? 'arm64' : 'amd64',
            fsp,
            join,
          ).catch(() => null);
    if (exposed === null) {
      this.logger.warn(
        `读不到镜像 ${ref} 声明的端口（BoxLite 本地库里没有它的 config，或格式不认识），本次不发布任何端口；` +
          '若该镜像其实 EXPOSE 了端口，BoxLite 会按原端口号发布，同一镜像的第二个 box 会因端口冲突而创建失败',
      );
      return [];
    }
    const tcp = exposed.filter((p) => p.protocol === 'tcp');
    if (tcp.length === 0) return [];
    const hostPorts = await allocateHostPorts(tcp.length);
    return tcp.map((p, i) => ({ hostPort: hostPorts[i]!, guestPort: p.port }));
  }

  /**
   * 04 §2「可选方法」实现（契约里的长注释解释了平台为什么问这个问题）。
   *
   * 它读的是 BoxLite 自己的 image store 索引 —— **不是**平台的任何一张表。一次
   * `images.list()` 就是一条本地 SQLite 查询，与那 190 秒相比可以忽略；而平台侧的
   * 「这个镜像以前有沙箱跑成功过」是个会说谎的代理量（store 可能被清、上次也可能
   * 是拉了一半就失败的），拿它当答案就等于用记账代替事实。
   *
   * ⚠️ 出错时**抛**，不返回 `false`。调用方（provision workflow）把异常读作
   * 「问不出来」并让字段缺席，而 `false` 会被读成「本机确实没有」—— 一次 store
   * 读不出来于是告诉用户「首次使用，要等几分钟」，是拿故障冒充事实。
   */
  async imageStaged(image: ResolvedImageSpec): Promise<boolean> {
    return this.guard(async () => {
      const runtime = await this.getRuntime();
      return isImageStaged(await runtime.images.list(), image);
    });
  }

  /**
   * 把镜像铺进 BoxLite 自己的库 —— **不建 box**（契约 `stageImage`）。
   *
   * ⚠️ **这就是 `create()` 里那 190 秒/20 分钟的前半段**，只是提前到向导第 3 步发生。
   * 后置到第一个任务的代价是实测出来的：这台机器到 ghcr 的带宽 **273 KB/s**，
   * 而 arm64 那份是 8 层、压缩后 320MB ⇒ 约 20 分钟。那 20 分钟落在
   * 「用户写完指令点了发起」之后，是整条链路上最差的时机。
   *
   * ⚠️ **传给 SDK 的 reference 必须与 `create()` 用的是同一个** —— `pinnedImageRef(image)`。
   * BoxLite 的 store 按「递给它的那个字符串」逐字记账（见 `boxlite-image-store.ts` 的
   * 实测），拿一个 tag 去铺、拿 digest 去问，会得到「铺过了但查不到」。
   *
   * ⚠️ **幂等**：已经在库里时 `pull` 直接返回，不重下（契约要求可重复调用）。
   */
  async stageImage(
    image: ResolvedImageSpec,
    onProgress?: (bytesDownloaded: number) => void,
  ): Promise<void> {
    return this.guard(async () => {
      const runtime = await this.getRuntime();
      const home = boxliteHome();
      // ⚠️ **进度靠轮询自己的层缓存**，因为 SDK 的 `pull()` 不给回调（0.9.7 实测：
      //    `ImageHandle` 就是 `{ pull, list }`）。⛔ 没有它，一次 320MB 的拉取在
      //    273 KB/s 的链路上就是 20 分钟静默 —— 用户看不到「下载了多少」。
      //
      // ⚠️ 1 秒一次：层缓存是**一个扁平目录、8 个文件**，一次 stat 遍历可以忽略；
      //    更密没有意义（进度条不需要更快），更疏用户会觉得卡住。
      // ⚠️ 测不出来就**一次都不报**（`imageStageProgress` 返回 null）—— 契约那条
      //    「宁可沉默也不要猜」。调用方于是退回「已用时长」。
      // ⚠️ **基线在这里减掉**（契约：报的是「本次新落盘字节」）。库里本来就有别的镜像的
      //    层，不减的话进度条一上来就停在某个高位 —— 那比没有进度更让人困惑。
      //    ⚠️ 测不出基线（目录还不存在 = 头一次拉）就按 0 算，那时它本来就是 0。
      // ⚠️ **按这张镜像自己的清单量，⛔ 不再用「全店字节 − 基线」那一套**（2026-09-14 改）。
      //    旧算法只在缓存**单调增长**时成立，而实测不是：153 KB/s 的链路上那个 210MB 的
      //    大层下到一半就断，boxlite **把半截层删掉重来** —— `images/layers` 从 157MB 掉回
      //    112MB（文件 8 → 7）。于是 `当前 − 基线` 变负、被 `Math.max(0, …)` 钉死在 0：
      //    界面显示「已下载 2MB · 1%」，而磁盘上其实已有 8 层里的 7 层
      //    （109.8/319.8 ≈ **34%**），「已用时长」还在跳 22 分钟 —— 用户看到的就是
      //    「一直在反复跑」。详见 `imageStageProgress` 的注释。
      // ⚠️ 架构名映射照 `oci-registry.client.ts` 既有写法（OCI 用 `amd64`，Node 用 `x64`），
      //    ⛔ 别自己发明一份。
      const wantArch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      const timer =
        onProgress === undefined
          ? undefined
          : setInterval(() => {
              void imageStageProgress(home, image.digest, wantArch, fsp, join).then((p) => {
                // ⛔ 测不出来就**不报**（契约那条「宁可沉默也不要猜」）——⚠️ 不是报 0：
                //    一个 0 会画成「一直卡在 0%」，而字节明明在进来。
                if (p !== null) onProgress(p.have);
              });
            }, 1_000);
      try {
        await runtime.images.pull(pinnedImageRef(image));
      } finally {
        // ⛔ **必须清**：不清会让进程永远醒着，而这是一条只在向导里走一次的路
        //    —— 泄漏一个定时器不会有人发现。放 finally 里，失败也清。
        if (timer !== undefined) clearInterval(timer);
      }
    });
  }

  async start(handle: SandboxHandle): Promise<void> {
    return this.guard(async () => {
      const box = await this.findBox(handle);
      if (box === null) {
        throw new SandboxProviderError(
          SandboxProviderErrorCode.NOT_FOUND,
          `box ${handle.providerSandboxId} not found`,
        );
      }
      if (!box.info().state.running) await box.start();
      await this.waitExecReady(handle);
    });
  }

  async stop(handle: SandboxHandle): Promise<void> {
    return this.guard(async () => {
      const box = await this.findBox(handle);
      if (box) await box.stop();
    });
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    return this.guard(async () => {
      await this.removeQuietly(handle.providerSandboxId);
    });
  }

  /**
   * 按 sandboxId 清掉曾经建过的那个 box（契约 `destroyBySandboxId`）—— auth helper 的
   * 「先清残留再建」靠它，不再依赖开机对账和模块顺序。
   *
   * ⚠️ 名字只在 `boxName` 一处推导（前缀带实例指纹），所以只会删到**本实例**的那一个；
   *    native `remove` 本来就认 id 或名字。不存在时正常返回（幂等，契约要求）。
   *
   * ⚠️⚠️ **还在跑的先礼貌停机，再 force remove**（与任务 teardown 的「先 stop 再 destroy」
   *    同一条纪律）。BoxLite 0.9.7 的 force remove 只对记录里的外层 bwrap 发 SIGTERM→SIGKILL，
   *    detached box 的内层 bwrap + shim + VM 要靠该 box 自己 cgroup 的 `cgroup.kill` 兜底；
   *    而 helper 是每个容器里建的第一个 box，cgroup 委派不生效时它恰好没有这个兜底 ⇒ VM 进程
   *    留成孤儿，发版探针从此判忙。`stop()` 先做 guest shutdown（BoxLite 自己限 10 秒），VM
   *    关机后整棵进程树随之退出。停不下来也照删 —— 停机是礼貌，删除才是权威。
   *    开机时的旧 helper 已被 BoxLite 标成 stopped，这一步直接跳过。
   */
  async destroyBySandboxId(sandboxId: string): Promise<void> {
    return this.guard(async () => {
      const name = this.boxName(sandboxId);
      await this.stopBeforeRemoval(name);
      if (await this.removeQuietly(name)) {
        this.logger.log(`removed box ${name} (destroyBySandboxId ${sandboxId})`);
      }
    });
  }

  /** {@link destroyBySandboxId} 的礼貌停机：只对还在跑的 box，限时，⛔ 从不抛。 */
  private async stopBeforeRemoval(name: string): Promise<void> {
    try {
      const runtime = await this.getRuntime();
      const box = await runtime.get(name);
      if (box === null || box.info().state.running !== true) return;
      const outcome = await new Promise<'stopped' | 'timed-out'>((resolve, reject) => {
        const timer = setTimeout(() => resolve('timed-out'), COURTESY_STOP_MS);
        timer.unref?.();
        box.stop().then(
          () => {
            clearTimeout(timer);
            resolve('stopped');
          },
          (e: unknown) => {
            clearTimeout(timer);
            reject(e instanceof Error ? e : new Error(String(e)));
          },
        );
      });
      if (outcome === 'timed-out') {
        this.logger.warn(
          `box ${name} did not stop within ${String(COURTESY_STOP_MS / 1000)}s; force-removing it anyway`,
        );
      }
    } catch (e: unknown) {
      this.logger.warn(
        `could not stop box ${name} before removing it (${e instanceof Error ? e.message : String(e)}); force-removing it anyway`,
      );
    }
  }

  /**
   * force remove；已经不在 ⇒ 幂等返回 `false`（04 §2.2），真删掉了 ⇒ `true`，其余错误照抛。
   * ⚠️ 返回值只为日志：「box id 为什么变了」事后要能从日志里还原。
   */
  private async removeQuietly(idOrName: string): Promise<boolean> {
    const runtime = await this.getRuntime();
    try {
      await runtime.remove(idOrName, true);
      return true;
    } catch (e: unknown) {
      if (!/not found|no such|unknown/i.test((e as Error).message)) throw e;
      return false;
    }
  }

  /**
   * ⚠️ **`health` 是本轮补上的**（03 §7.8）。契约里 `SandboxRuntimeStatus.health` 早就
   * 定义好了，两个 provider 的 `inspect()` 一直没填 —— 于是「running 但 agent 已挂」
   * 这件事平台一个信号都没有。
   *
   * 这里填的是**零成本层**：`getInfo()` 是纯本地状态（实测 0ms），`metrics()` 0.1ms，
   * **两者都不进沙箱**。进沙箱那一步（一次最小 exec）由 `SandboxHealthMonitor` 在
   * 「出现异常迹象」时才做 —— 理由见 `boxlite-health.ts` 顶部那条教训。
   *
   * ⚠️ `metrics()` 拿不到就**不带** `execErrorsTotal`（不退化成 0）：0 是「一次都没
   * 错过」这个断言，缺席才是「没问出来」。
   *
   * ⚠️ **记录说 running 不等于 VM 还在**：VM 被 `kill -9` 之后 BoxLite 照报 running（0.9.7
   * 不配 health check 时没有退出监视）。所以 running 的记录先按 shim 进程核一次
   * （`shimLiveness`，只读 `shim.pid` 与 `/proc`）：确认已不在 ⇒ `instance_dead`，并且
   * ⛔ 不再碰 `metrics()` —— 那会在新建的 BoxImpl 上去 attach 一个死掉的 shim。核不出来
   * （没有 procfs、文件认不出来）⇒ 照旧按记录说话。
   * 读它的有三处：helper 的存活复核与诊断（`instance_dead` ⇒ 失效、重建）、
   * `SandboxHealthMonitor`（读作异常迹象，交给数据面确认）、`QuotaReconciler`（只认
   * `instance_missing` 是查无，`instance_dead` 照样占着名额 —— 盘还在）。
   */
  async inspect(handle: SandboxHandle): Promise<SandboxRuntimeStatus> {
    try {
      const runtime = await this.getRuntime();
      const info = await runtime.getInfo(handle.providerSandboxId);
      if (!info) return { lifecycleState: 'instance_missing' };
      const shimGone =
        info.state.running === true && (await shimLiveness(handle.providerSandboxId)) === 'gone';
      const running = info.state.running === true && !shimGone;
      // SDK metrics() acquires live state and can implicitly start a stopped VM.
      // Reconciliation must preserve stopped tasks and their retained registrations.
      const execErrorsTotal = running ? await this.execErrorsTotal(handle) : undefined;
      const at = info.healthStatus?.lastCheck ?? this.clock?.now().toISOString();
      const reading =
        at === undefined
          ? null
          : readBoxliteHealth({
              running,
              ...(shimGone ? { notRunningBecause: SHIM_GONE } : {}),
              state: {
                state: info.healthStatus?.state ?? 'None',
                failures: info.healthStatus?.failures ?? 0,
                ...(info.healthStatus?.lastCheck === undefined
                  ? {}
                  : { lastCheck: info.healthStatus.lastCheck }),
              },
              ...(execErrorsTotal === undefined ? {} : { execErrorsTotal }),
              at,
            });
      return {
        lifecycleState: shimGone
          ? 'instance_dead'
          : this.mapState(info.state.status, info.state.running),
        ...(reading === null ? {} : { health: reading.health }),
        raw: {
          ...info,
          ...(shimGone ? { shimProcess: 'gone' } : {}),
          ...(execErrorsTotal === undefined ? {} : { execErrorsTotal }),
        },
      };
    } catch (e) {
      throw this.toProviderError(e);
    }
  }

  /**
   * 零成本的异常指示器（03 §7.8）。**拿不到就缺席**，不编一个 0 出来。
   * ⚠️ 整段 catch 掉：一次拿不到 metrics 绝不该让 `inspect()` 抛 —— 那会把一个只想
   * 「看看状态」的调用变成一次 provision 失败（03 §7.8 实现纪律 2 的同一形状）。
   */
  private async execErrorsTotal(handle: SandboxHandle): Promise<number | undefined> {
    try {
      const box = await this.findBox(handle);
      // A concurrent stop may finish between getInfo() and acquiring this fresh handle.
      if (!box || box.info().state.running !== true) return undefined;
      const metrics = await box.metrics();
      return typeof metrics.execErrorsTotal === 'number' ? metrics.execErrorsTotal : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 平台唯一的「在沙箱里跑东西」原语。翻译全在 `boxlite-process.stream.ts`：
   * `tty:false` → `box.exec(tty=false)` + `wait()`；`tty:true` → `tty=true` +
   * `stdin()` + `resizeTty()`。`env` / `cwd` / `user` / `timeoutMs` / `stdin` /
   * `cols,rows` 在 native 侧**全是原生参数**，没有翻译损耗。
   */
  async spawn(handle: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> {
    return this.guard(async () => spawnNative(await this.requireBox(handle), spec));
  }

  /**
   * micro-VM 的名字里编进**实例指纹**。boxlite 没有 docker 那样的标签机制,名字是
   * 唯一能带身份的地方 —— 而启动对账要靠它区分"这个 box 归谁管"(见
   * `reconcile/instance-id.ts`:不加区分的话,e2e 一跑就把开发者 demo 的 box 全清了)。
   *
   * ⚠️ 格式与 `RuntimeReconciler` 的 `minePrefix` **必须同源**,改一处就要改另一处;
   * 下面的单测把两边钉在一起。
   */
  private boxName(sandboxId: string): string {
    return `${boxliteNamePrefix()}${sandboxId}`;
  }

  private async requireBox(handle: SandboxHandle): Promise<BoxliteBox> {
    if (handle.provider !== this.name) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        `sandbox handle belongs to provider '${handle.provider}', not '${this.name}'`,
      );
    }
    const box = await this.findBox(handle);
    if (!box) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.NOT_FOUND,
        `box ${handle.providerSandboxId} not found`,
      );
    }
    // ⛔ **平台自持的实例（auth helper）停了就该重建，不许经数据面被隐式拉起。** BoxLite 0.9.7
    //    对 stopped / failed 的 box 做 exec 会直接走 restart 流水线，用旧 rootfs 把它复活（旧
    //    rootfs 里可能有刷新时短暂落盘的凭证），还绕过了 `start()` 的就绪等待。helper 拿到这个
    //    INVALID_STATE 会作废句柄、重建一个新的（`ContainerAuthHelper`）。
    // ⚠️ 只管平台自持的这一类：任务沙箱的数据面今天就依赖这次隐式拉起（例如读一个已停止任务
    //    的产物），收不收紧是另一件事，不夹带在这里。
    const info = box.info();
    if (info.state.running !== true && this.isPlatformOwnedBox(info.name)) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        `platform box ${info.name ?? handle.providerSandboxId} is ${info.state.status}, not running; ` +
          'it is recreated rather than revived',
      );
    }
    return box;
  }

  /** 名字是不是「本实例前缀 + 平台自持的固定 sandboxId」（auth helper）。 */
  private isPlatformOwnedBox(name: string | undefined): boolean {
    const prefix = boxliteNamePrefix();
    return (
      name !== undefined &&
      name.startsWith(prefix) &&
      isPlatformOwnedSandboxId(name.slice(prefix.length))
    );
  }

  private async findBox(handle: SandboxHandle): Promise<BoxliteBox | null> {
    const runtime = await this.getRuntime();
    return runtime.get(handle.providerSandboxId);
  }

  private mapState(status: string, running: boolean): SandboxRuntimeLifecycleState {
    if (running) return 'instance_running';
    switch (status.toLowerCase()) {
      case 'created':
        return 'instance_creating';
      case 'paused':
        return 'instance_paused';
      case 'exited':
      case 'stopped':
        return 'instance_exited';
      case 'dead':
        return 'instance_dead';
      default:
        return 'instance_missing';
    }
  }

  /**
   * 就绪门槛：**能跑起来一条命令**，而不是「某个 HTTP 端口应答了」。
   *
   * ── 这里换掉了什么 ──────────────────────────────────────────────────────
   * 上一版是 `waitForAgent`：轮询转发端口上的沙箱内 agent，要求带 token 的请求 2xx
   * 且匿名请求被拒。那三件事（端口转发、token、匿名自检）随数据面一起没了；剩下的
   * 「第一次 spawn 不能撞上一个还没起来的实例」这个真实需求，用**平台自己的执行
   * 通道**验证——这正是 04 §2.1★ 那条方法论教训（平台行为必须用平台自己的路径验证）。
   *
   * ── 预算怎么算出来的（全部实测，2026-08-26） ──────────────────────────────
   *  · `runtime.create()` 本身 ~4ms：**它是懒的**，微 VM 在**第一次 exec** 时才真起。
   *  · 镜像已在 BoxLite store 里时，第一次 exec（含 boot）**3.2–4.1s**。
   *  · 冷 store 要在这一步现拉 + 铺 rootfs，ADR 记录的量级是 **~220s**。
   *  · 顺带的量级参考：`codex --version` 在微 VM 里要 **18.6s**（docker 里 44ms，420×），
   *    所以「几百毫秒」那种按容器定的预算在这一档一律不成立。
   *  ⇒ 300s 是「冷拉 220s × 1.4 的余量」，不是随手写的整数；上一版的 360s 里有一大半
   *    是在等镜像里那个 python agent 起来，那部分现在不存在了。
   */
  private async waitExecReady(
    handle: SandboxHandle,
    attempts = READY_ATTEMPTS,
    intervalMs = READY_INTERVAL_MS,
  ): Promise<void> {
    let last = '';
    for (let i = 0; i < attempts; i++) {
      const box = await this.findBox(handle).catch(() => null);
      if (box !== null) {
        const probe = await runGuestScript(box, 'exit 0').catch((e: unknown) => {
          last = e instanceof Error ? e.message : String(e);
          return null;
        });
        if (probe !== null && probe.code === 0) return;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new SandboxProviderError(
      SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
      `boxlite micro-VM ${handle.providerSandboxId} did not accept an exec in time` +
        (last === '' ? '' : `: ${last}`),
      undefined,
      true,
    );
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw this.toProviderError(e);
    }
  }

  private toProviderError(e: unknown): SandboxProviderError {
    if (e instanceof SandboxProviderError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    // ⚠️ A DIGEST THAT IS GONE IS NOT 「pull failed」, AND IT MUST BE TESTED FIRST.
    // Pinning by digest created a failure mode that following a tag never had: the
    // address is exactly right and the bits behind it were deleted/GC'd upstream.
    // Retrying and editing the address are both useless — the way out is [检查更新].
    // Different thing to do ⇒ different code (04 §4 四类分类法). It is checked before
    // the generic `not found` rule because that rule would otherwise swallow it.
    if (/manifest unknown|not found|no such/i.test(msg) && /@sha256:/.test(msg)) {
      return new SandboxProviderError(SandboxProviderErrorCode.IMAGE_DIGEST_GONE, msg, e);
    }
    if (/not found|no such|unknown/i.test(msg)) {
      return new SandboxProviderError(SandboxProviderErrorCode.NOT_FOUND, msg, e);
    }
    if (/manifest unknown|pull|registry|image/i.test(msg)) {
      return new SandboxProviderError(SandboxProviderErrorCode.IMAGE_PULL_FAILED, msg, e);
    }
    return new SandboxProviderError(SandboxProviderErrorCode.INTERNAL, msg, e);
  }
}

/** 就绪轮询：600 × 500ms = 300s。预算的依据见 `waitExecReady` 的注释。 */
const READY_ATTEMPTS = 600;
const READY_INTERVAL_MS = 500;

/**
 * `destroyBySandboxId` 礼貌停机的上限：BoxLite 的 guest shutdown 自己最多等 10 秒，之后
 * 对外层 bwrap SIGTERM、2 秒后 SIGKILL —— 20 秒把这两段都盖住（与任务 teardown 的
 * `stopForTeardown` 同一个数）。超时不等，照删。
 */
const COURTESY_STOP_MS = 20_000;

/** `inspect` 核出 shim 已不在时，健康读数里那句原因。 */
const SHIM_GONE =
  'BoxLite still records the box as running, but its shim process is gone (shim.pid / /proc)';

/**
 * 占 `count` 个**互不相同**的空闲宿主端口号。
 *
 * ⚠️ 先把 `count` 个 `listen(0)` 同时开着、拿到号之后再一起关 —— 逐个「开、取号、关」的话
 *    内核可以把刚关掉的号再发一次，两条映射撞在同一个宿主端口上。
 * ⚠️ 取号绑的是 **`0.0.0.0`**，与 gvproxy 真正绑定的地址一致：只在 `127.0.0.1` 上取号，
 *    拿到的号可能正被别的网卡上的监听占着，gvproxy 绑通配地址时照样撞。
 * ⚠️ 仍有 TOCTOU 窗口，而且**不小**：号码在 `create()` 时写进 BoxLite 的 box_config，gvproxy
 *    却要到 `start()` 的 VmmSpawn 才真正 bind —— 中间可能隔着一次冷拉镜像（分钟级），之后
 *    每次 start 都复用同一个号。这是「best effort」而不是保证；撞上了 start 会响亮失败。
 *    用它换来的是「同一台机器上能同时跑多个声明了端口的 boxlite 沙箱」，而固定端口是**必然**冲突。
 * ⚠️ 不设 `hostIp`：实测 BoxLite **忽略**这个字段（传 `127.0.0.1` 也照样绑
 *    `*:<port>`），写上去只会留下一句与实现不符的注释。
 */
async function allocateHostPorts(count: number): Promise<number[]> {
  const servers: Server[] = [];
  try {
    const ports: number[] = [];
    for (let i = 0; i < count; i++) {
      const srv = createServer();
      servers.push(srv);
      ports.push(
        await new Promise<number>((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(0, '0.0.0.0', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            if (port > 0) resolve(port);
            else reject(new Error('could not allocate a host port'));
          });
        }),
      );
    }
    return ports;
  } finally {
    await Promise.all(
      servers.map((srv) => new Promise<void>((resolve) => srv.close(() => resolve()))),
    );
  }
}
