import { createServer } from 'node:net';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
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
import { getSharedBoxliteRuntime, type BoxliteBox, type BoxliteRuntime } from './boxlite-runtime';
import { boxliteNamePrefix } from '../../reconcile/instance-id';
import { spawnNative } from './boxlite-process.stream';
import { BoxliteSandboxFiles } from './boxlite-files';
import { BoxliteSandboxJobs } from './boxlite-jobs';
import { withClosedGatewayEnv } from './boxlite-exposed-port';
import { runGuestScript } from './boxlite-guest-shell';
import { isImageStaged } from './boxlite-image-store';
import { readBoxliteHealth } from './boxlite-health';

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
 * BoxLite 会把镜像 `EXPOSE` 的 `:8080` 自动发布到宿主通配地址且关不掉，所以那扇门必须
 * 上一把没人有钥匙的锁。整段论证与实测见 `boxlite-exposed-port.ts`。
 *
 * 镜像经**本地 registry 中转**拉取（ADR 工程注记：BoxLite 自己的 image store 不支持
 * 断点续传，大镜像要经 `localhost:5001` 中转）；`imageRegistries` 里保留 `docker.io`，
 * 否则连微 VM 的 bootstrap base（`debian:bookworm-slim`）都拉不到。
 */
@Injectable()
export class BoxliteSandboxProvider implements SandboxProvider {
  readonly name = 'boxlite';

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
          // 见 `boxlite-exposed-port.ts`：这不是数据面，是给镜像自动发布出去的 :8080
          // 上一把没人有钥匙的锁。
          env: Object.entries(withClosedGatewayEnv(ctx.env)).map(([key, value]) => ({
            key,
            value,
          })),
          volumes: (ctx.volumes ?? []).map((v) => ({
            hostPath: v.source,
            guestPath: v.target,
            readOnly: v.mode === 'ro',
          })),
          // ⚠️ **这条映射不是数据面，是在给自动发布挪窝——删掉它会让「同时只能起一个
          // boxlite 沙箱」。** 详细实测见 `boxlite-exposed-port.ts`：BoxLite 会把镜像
          // `EXPOSE` 的 8080 自动发布到宿主，且**关不掉**；不给映射时它落在**固定的**
          // `*:8080`，于是第二个 box 直接起不来——
          // `gvproxy_create failed: ... listen tcp 0.0.0.0:8080: bind: address already in use`
          // （本仓 e2e 一次跑两个 boxlite 沙箱时真的红过）。给 guest 8080 指定一个
          // **空闲宿主端口**，自动发布就落到那个唯一端口上，冲突消失。
          // 端口号**不落库**：没有任何东西会去连它（数据面全在 native 那侧），
          // 所以它是一次性的、不需要跨重启还原 —— 这正是 `providerState` 能空掉的原因。
          ports: [{ hostPort: await freeHostPort(), guestPort: IMAGE_EXPOSED_AGENT_PORT }],
        },
        this.boxName(ctx.sandboxId),
      );
      // providerState 为空：native 通道要的全部信息就是 box id 本身。
      return { provider: this.name, providerSandboxId: box.id };
    });
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
      const runtime = await this.getRuntime();
      await runtime.remove(handle.providerSandboxId, true).catch((e: unknown) => {
        // already gone ⇒ idempotent (04 §2.2)
        if (!/not found|no such|unknown/i.test((e as Error).message)) throw e;
      });
    });
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
   */
  async inspect(handle: SandboxHandle): Promise<SandboxRuntimeStatus> {
    try {
      const runtime = await this.getRuntime();
      const info = await runtime.getInfo(handle.providerSandboxId);
      if (!info) return { lifecycleState: 'instance_missing' };
      const execErrorsTotal = await this.execErrorsTotal(handle);
      const at = info.healthStatus?.lastCheck ?? this.clock?.now().toISOString();
      const reading =
        at === undefined
          ? null
          : readBoxliteHealth({
              running: info.state.running,
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
        lifecycleState: this.mapState(info.state.status, info.state.running),
        ...(reading === null ? {} : { health: reading.health }),
        raw: { ...info, ...(execErrorsTotal === undefined ? {} : { execErrorsTotal }) },
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
      if (!box) return undefined;
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
    return box;
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
 * AIO 镜像 `EXPOSE` 的那个端口。平台**不连它**（数据面全在 native 侧）；写在这里只是
 * 因为 BoxLite 的自动发布认这个号，我们要把它挪到一个唯一的宿主端口上（见 `create`）。
 */
const IMAGE_EXPOSED_AGENT_PORT = 8080;

/**
 * 占一个空闲的宿主端口号。
 *
 * ⚠️ 有一个很小的 TOCTOU 窗口（listen(0) 拿到号 → close → BoxLite 再 bind），这是
 * 「best effort」而不是保证；撞上了 `create()` 会响亮失败，重试即可。用它换来的是
 * 「同一台机器上能同时跑多个 boxlite 沙箱」，而固定 8080 是**必然**冲突。
 * ⚠️ 不设 `hostIp`：实测 BoxLite **忽略**这个字段（传 `127.0.0.1` 也照样绑
 * `*:<port>`），写上去只会留下一句与实现不符的注释。
 */
function freeHostPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not allocate a host port'))));
    });
  });
}
