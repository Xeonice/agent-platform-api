import { Inject, Injectable, Optional } from '@nestjs/common';
import type Docker from 'dockerode';
import {
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
  type SandboxRuntimeStatus,
} from '@platform/contracts';
import { CLOCK } from '@platform/shared-kernel';
import type { Clock } from '@platform/shared-kernel';
import { readAioHealth } from './aio-health';
import { DOCKER_CLIENT } from '../docker/docker.token';
import { DockerContainerRuntime } from '../docker/docker-container-runtime';
import type { ContainerRuntime } from '../container-runtime.port';
import { AioSandboxAgentClient } from './aio-sandbox-agent.client';
import { agentProviderState, readAgentState } from './agent-state';
import { AgentSandboxFiles, AgentSandboxJobs } from './agent-data-plane';
import {
  AGENT_PING_PATH,
  assertAgentRejectsAnonymous,
  authHeader,
  createAgentAuthMaterial,
  withAgentAuthEnv,
  withJobSurvivalEnv,
} from './agent-auth';
import { INSTANCE_LABEL, platformInstanceId } from '../../reconcile/instance-id';

/**
 * `aio` —— 默认方案（04 §2.1，SANDBOX-RUNTIME-DECISIONS 决策 A/B）。
 *
 * ══ 两个面，各自独立 ═══════════════════════════════════════════════════════════
 *
 * | | 是什么 | 谁实现 |
 * |---|---|---|
 * | **控制面** | 起/停/删/查这个实例 | 注入的 `ContainerRuntime`（今天是 docker） |
 * | **数据面** | exec / pty / files / jobs | **AIO 镜像自带的 HTTP+WS API** |
 *
 * 数据面走的是**沙箱自己的接口**——这与 boxlite 走 BoxLite native exec 是**对称**的：
 * 两边都是「问沙箱要」，而不是「从外面撬」。所以这里没有一行 `docker exec`：
 * `docker exec` 会绕过 `/v1/bash/exec` 的 `hard_timeout`、绕过 job 的存活语义
 * （`BASH_SESSION_TIMEOUT` / `MAX_BASH_SESSIONS`），也绕过沙箱内 nginx 的那道门。
 *
 * ⚠️ **这个类曾经是 `extends DockerContainerBackend` 的一层空壳**（构造函数里塞一个
 * config 对象，没有别的）。继承把「方案」与「docker」焊死：`aio` 在**类型上**就是一个
 * docker 后端。换成组合之后，把 `DockerContainerRuntime` 换成 podman / k8s / 远程主机
 * 的实现，数据面一行都不用动——这正是拆开它的全部理由（见 `container-runtime.port.ts`）。
 *
 * 镜像自带 entrypoint（它负责拉起 `:8080` 的 agent），因此**不设 keep-alive 命令**；
 * agent 端口只发布到宿主 loopback，并由 `SANDBOX_API_KEY` 把门（`agent-auth.ts`）。
 */
@Injectable()
export class AioSandboxProvider implements SandboxProvider {
  readonly name = 'aio';

  /** AIO 镜像内 agent 的固定监听端口。 */
  private static readonly AGENT_PORT = 8080;
  /** 单次健康探测的超时；远小于 30s 采样周期（03 §7.8「否则探测自己会堆积」）。 */
  private static readonly PROBE_TIMEOUT_MS = 3000;

  /**
   * ⚠️ **三位在 2026-08-29 从 `true` 改回 `false`，因为它们是谎报**（CAP-03 事故记录）。
   *
   * | 位 | 原值 | 真相 |
   * |---|---|---|
   * | `updateResources` | `true` | 从来没有 `updateResources()` 方法 |
   * | `pauseResume` | `true` | 契约里**根本没有** pause/resume 方法 |
   * | `watchEvents` | `true` | 从来没有 `watchEvents()` 方法（boxlite 也一样） |
   *
   * 它们从旧 `DockerContainerBackend` 的 config 里原样继承下来，而**没有任何测试要求
   * 任何一位兑现**——CAP-01 只查「七位齐全且是 boolean」，CAP-02 只查 `headlessTask`。
   *
   * ⚠️ **这不是洁癖**：`assertCapabilities` 照着这些位放行
   * `create({ require: { updateResources: true } })`——用户说「我要能调整配额的沙箱」，
   * 平台答应了，然后没有任何 API 能调整。`GET /api/providers` 也照着它们告诉前端该画
   * 哪些控件。
   *
   * ⚠️ **docker 本身当然支持 `pause`/`unpause`/`update`。** 但那是「**将来可以实现**」，
   * 不是「**现在已实现**」——这一位说的是后者。顺序是 **先加方法，再改这一位**
   * （boxlite 的 `snapshot` 注释里写的是同一条：SDK 有完整快照 API，位仍然是 `false`）。
   */
  readonly capabilities: SandboxProviderCapabilities = {
    spawnTty: true,
    volumeMount: true,
    updateResources: false,
    pauseResume: false,
    snapshot: false,
    watchEvents: false,
    headlessTask: true,
  };

  /**
   * 两个可选面（04 §2.6）。**成组出现**，与 `headlessTask` 一位严格互证：
   * `true` 却没有面 ⇒ 应用层去调 `undefined`；有面却 `false` ⇒ `GET /api/providers`
   * 藏起一个真实存在的能力，而前端的控件正是照着这一位画的（CAP-02）。
   */
  readonly jobs: SandboxJobs;
  readonly files: SandboxFiles;

  private readonly runtime: ContainerRuntime;

  constructor(
    @Inject(DOCKER_CLIENT) docker: Docker,
    /**
     * ⚠️ **`@Optional()` 不是可有可无的装饰**：`ContainerRuntime` 是一个 interface，
     * `emitDecoratorMetadata` 只能把它记成 `Object`，于是 Nest 会去容器里找一个叫
     * `Object` 的 provider 然后报 `can't resolve dependencies`——一个 TS 默认参数值
     * 救不了它（DI 在默认值生效之前就失败了）。
     *
     * 为什么不给它一个 Nest token：控制面今天只有 docker 一种实现，多一个 token 只会
     * 多一层间接。要换实现时，要么改下面这个 `??` 的右边，要么从外面 `new` 进来
     * （测试就是这么做的）——两条路都不需要碰数据面，这正是拆开它的目的。
     */
    @Optional() runtime?: ContainerRuntime,
    /** 见 `BoxliteSandboxProvider` 同一处注释：只用来盖采样时刻，没有就不填 `health`。 */
    @Optional() @Inject(CLOCK) private readonly clock?: Clock,
  ) {
    this.runtime = runtime ?? new DockerContainerRuntime(docker);
    const clientFor = (handle: SandboxHandle): Promise<AioSandboxAgentClient> =>
      this.agentClient(handle);
    this.jobs = new AgentSandboxJobs(this.name, clientFor);
    this.files = new AgentSandboxFiles(this.name, clientFor);
  }

  async create(ctx: SandboxProviderContext): Promise<SandboxHandle> {
    // 每个沙箱一把 key：同一个值既经 env 启动镜像自己的鉴权网关，也随 handle 走
    // （它是**共享秘密**，不是密钥对——这是 2026-08 从自造 RS256 JWT 迁过来后的形状）。
    // 没有它，loopback 上发布的那个端口对本机每一个进程都是一个无鉴权 shell
    // （ADR 安全姿态）。
    const auth = createAgentAuthMaterial();
    // 生存义务 (04 §2.6 ★★★): 宣称 `headlessTask` 就必须让 agent 的会话回收器与会话
    // 上限活得比它接受的最长 job 还久，而 agent 是在**开机时**读这两个 env 的
    // ——所以这是唯一能做这件事的时刻。
    const env = withJobSurvivalEnv(withAgentAuthEnv(ctx.env, auth));
    const id = await this.runtime.create({
      sandboxId: ctx.sandboxId,
      instanceName: `platform-${this.name}-${ctx.sandboxId}`,
      image: ctx.image,
      env,
      labels: {
        ...(ctx.labels ?? {}),
        'platform.managed': 'true',
        // 谁能回收这个容器（见 instance-id.ts）。不打这一位的容器**永远不会被
        // 自动回收**——那是本改动的保守面：升级前建的容器宁可漏收,也不能误删。
        [INSTANCE_LABEL]: platformInstanceId(),
        'platform.provider': this.name,
        'platform.isolation': 'container',
        'platform.sandboxId': ctx.sandboxId,
      },
      quota: ctx.quota,
      volumes: ctx.volumes ?? [],
      agentPort: AioSandboxProvider.AGENT_PORT,
    });
    return {
      provider: this.name,
      providerSandboxId: id,
      // 平台替我们落库：端口能从运行时重新问出来，凭证不能——丢了就等于跨重启
      // 丢掉整个数据面（04 §7 / `agent-state.ts`）。
      providerState: agentProviderState({ agentAuthToken: auth.apiKey }),
    };
  }

  async start(handle: SandboxHandle): Promise<void> {
    await this.runtime.start(handle.providerSandboxId);
    // agent readiness gate (ADR 决策 A / 03): 容器 "running" 远早于沙箱内那个 HTTP
    // 服务能接连接。
    await this.waitForAgent(await this.agentOrigin(handle), readAgentState(handle).agentAuthToken);
  }

  async stop(handle: SandboxHandle, opts?: { timeoutSec?: number }): Promise<void> {
    await this.runtime.stop(handle.providerSandboxId, opts);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await this.runtime.destroy(handle.providerSandboxId);
  }

  /**
   * ⚠️ **`health` 是本轮补上的**（03 §7.8）：契约里 `SandboxRuntimeStatus.health` 早就
   * 定义好了，`inspect()` 一直没填。
   *
   * 判据是**平台自己用的那扇门**（`:8080` 的 `GET /v1/ping`，免鉴权），不是镜像自带
   * 的 HEALTHCHECK —— 后者探 8091+9222，默认路径下 60s 后必报 unhealthy 而沙箱完全
   * 可用。整段实测与论证在 `aio-health.ts`。`State.Health` 只作诊断详情进 `message`。
   *
   * ⚠️ **整个探测被 catch 包住，抛不出去。** 一次 ping 失败/超时是「这一刻不健康或
   * 问不出来」，不是「inspect 失败」—— 让它冒泡就是 03 §7.8 实现纪律 2 那条坑
   * （一次探测异常冒泡成 provision 失败）。
   */
  async inspect(handle: SandboxHandle): Promise<SandboxRuntimeStatus> {
    const status = await this.runtime.inspect(handle.providerSandboxId);
    const at = this.clock?.now().toISOString();
    if (at === undefined) return status; // 没有 clock ⇒ 不编一个采样时刻出来
    if (status.lifecycleState === 'instance_missing') return status;
    const raw = status.raw as { Health?: { Status?: string; FailingStreak?: number } } | undefined;
    return {
      ...status,
      health: readAioHealth({
        agentReachable: await this.pingAgent(handle),
        ...(raw?.Health?.Status === undefined ? {} : { dockerHealth: raw.Health.Status }),
        ...(raw?.Health?.FailingStreak === undefined
          ? {}
          : { dockerFailingStreak: raw.Health.FailingStreak }),
        running: status.lifecycleState === 'instance_running',
        at,
      }),
    };
  }

  /**
   * 零成本层的那一问：`GET :8080/v1/ping`（镜像唯一免鉴权的路由）。
   *
   * ⛔ **不用 runtime CLI**（`codex --version` 那类）—— 03 §7.8 开场那条教训：一次意在
   * 「检查」的调用把被检查的 agent 打挂了。这里连沙箱都不进，只敲一次前门。
   *
   * `undefined` = **没问出来**（地址解析不出来 / 超时），不是「不健康」。
   */
  private async pingAgent(handle: SandboxHandle): Promise<boolean | undefined> {
    try {
      const base = await this.agentOrigin(handle);
      const ctrl = new AbortController();
      // ⚠️ 单次探测超时必须**远小于**采样周期（30s），否则探测自己会堆积。
      const timer = setTimeout(() => ctrl.abort(), AioSandboxProvider.PROBE_TIMEOUT_MS);
      try {
        return (await fetch(`${base}${AGENT_PING_PATH}`, { method: 'GET', signal: ctrl.signal }))
          .ok;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      // 连接被拒 = 前门没起来，这是一个**结论**；其余（地址解析不出来、abort）没结论。
      const message = e instanceof Error ? e.message : String(e);
      return /ECONNREFUSED|connect|fetch failed/i.test(message) ? false : undefined;
    }
  }

  async spawn(handle: SandboxHandle, spec: ProcessSpec): Promise<ProcessStream> {
    const client = await this.agentClient(handle);
    return spec.tty
      ? client.openTerminal(spec.cols ?? 80, spec.rows ?? 24, spec.cmd)
      : client.exec(spec);
  }

  private async agentOrigin(handle: SandboxHandle): Promise<string> {
    return this.runtime.agentOrigin(handle.providerSandboxId, AioSandboxProvider.AGENT_PORT);
  }

  private async agentClient(handle: SandboxHandle): Promise<AioSandboxAgentClient> {
    return new AioSandboxAgentClient(
      await this.agentOrigin(handle),
      readAgentState(handle).agentAuthToken,
    );
  }

  /**
   * 轮询到 agent 可用为止 —— **两问，缺一不可**。
   *
   * ① `GET /v1/ping`（镜像唯一免鉴权的路由）：证明 nginx 前门起来了。
   * ② 带 key 的 `GET /`：证明鉴权后端、注入的那把 key、上游服务**三样都活着**，
   *    于是第一条 exec 不会撞上一个半启动的网关。
   *
   * 然后 `assertAgentRejectsAnonymous` 反向再问一次：匿名必须被拒。
   *
   * ⚠️ 不能只问 ①：它免鉴权，因此在一张**根本没实现鉴权**的镜像上同样答 200。
   * 也不能只问 ②：它在网关还没起来时是连接被拒，与「key 错了」分不开。
   *
   * 固定次数 + 固定间隔（不读墙钟——`Date.now()` 在基础设施层被禁，01 §3）。
   */
  private async waitForAgent(
    base: string,
    key: string | undefined,
    attempts = 80,
    intervalMs = 250,
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        const ping = await fetch(`${base}${AGENT_PING_PATH}`, { method: 'GET' });
        if (ping.ok) {
          const res = await fetch(`${base}/`, { method: 'GET', headers: authHeader(key) });
          if (key === undefined || res.status < 400) {
            await assertAgentRejectsAnonymous(base, key);
            return;
          }
        }
      } catch {
        /* ECONNREFUSED / not yet listening */
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new SandboxProviderError(
      SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
      `in-sandbox agent at ${base} did not become ready`,
      undefined,
      true,
    );
  }
}
