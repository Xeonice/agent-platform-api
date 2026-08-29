import type Docker from 'dockerode';
import {
  pinnedImageRef,
  SandboxProviderError,
  SandboxProviderErrorCode,
  type SandboxRuntimeLifecycleState,
  type SandboxRuntimeStatus,
} from '@platform/contracts';
import type { ContainerCreateSpec, ContainerRuntime } from '../container-runtime.port';
import {
  isDnsResolvableContainerName,
  resolveAgentAddressing,
  type AgentAddressing,
} from './agent-addressing';

/**
 * `ContainerRuntime` 的 **docker 实现** —— 控制面，仅此而已。
 *
 * ⚠️ **它不再是一个 `SandboxProvider`。** 这个文件的前身 `DockerContainerBackend`
 * 同时是「注册的 aio 方案」和「docker 容器机制」和「`docker exec` 数据面」三样东西；
 * `AioSandboxProvider` 只是它的一层空壳（`extends` + 一个构造参数）。拆开之后：
 *
 *   · **方案**（能力位、jobs/files/spawn）→ `aio/aio-sandbox.provider.ts`
 *   · **数据面**（exec/pty/files/jobs）→ 沙箱自己的 HTTP/WS API，`aio/` 目录
 *   · **控制面**（起/停/删/查容器）→ 本文件
 *
 * ⚠️ **`docker exec` 数据面在这次拆分中被删掉了，不是搬走了。** 它当时的用途是
 * 「给没有 agent 的裸镜像兜底」，但平台注册的方案只有 aio（自带 agent）与 boxlite
 * （native exec），没有任何一条路会走到它。留着它的代价是留着一条**从外面撬进沙箱**
 * 的通道——它绕开沙箱自己的接口，因此也绕开 `hard_timeout`、job 存活语义和沙箱内的
 * 审计（04 §2.3）。一条没人走、又比正路弱的旁路，删掉比留着诚实。
 *
 * 错误分类（`toProviderError`）留在**这里**而不是提到端口上：`statusCode 404/409`、
 * `ECONNREFUSED /var/run/docker.sock` 全是 docker 的方言，podman 实现要给出自己的
 * 那一份翻译。端口上只约定**结果**（`SandboxProviderErrorCode`），不约定怎么认。
 */
export class DockerContainerRuntime implements ContainerRuntime {
  readonly kind = 'docker';

  constructor(
    private readonly docker: Docker,
    /**
     * **平台自己站在哪一侧**（`agent-addressing.ts`）。默认从 `SANDBOX_DOCKER_NETWORK`
     * 读，且默认值就是今天的行为——裸跑在宿主、端口发布到 loopback。
     *
     * ⚠️ 显式参数不是为了测试方便，而是因为**这是一条部署事实，不是一个运行期判断**：
     * 构造时定下来，之后每一次 `create`/`agentOrigin` 都照着同一份答案走。
     */
    private readonly addressing: AgentAddressing = resolveAgentAddressing(),
  ) {}

  async create(spec: ContainerCreateSpec): Promise<string> {
    return this.guard(async () => {
      const binds = spec.volumes.map((v) => `${v.source}:${v.target}:${v.mode}`);
      const portKey = `${spec.agentPort}/tcp`;
      const network = this.network();
      if (network !== null && !isDnsResolvableContainerName(spec.instanceName)) {
        // 名字不是一个 DNS label ⇒ 容器**照样起得来**，只是 `http://<名字>:8080`
        // 永远解析不了，报出来会是一条指向沙箱的 `did not become ready`。在门口拦下，
        // 把它变成一条说得出原因的错误（`agent-addressing.ts` 那段 ⚠️）。
        throw new SandboxProviderError(
          SandboxProviderErrorCode.INVALID_STATE,
          `instance name '${spec.instanceName}' is not a DNS label, so it cannot be resolved ` +
            `on the docker network '${network}' (SANDBOX_DOCKER_NETWORK). ` +
            'Names must be 1–63 chars of [a-z0-9-], starting and ending alphanumeric.',
        );
      }
      const container = await this.docker.createContainer({
        name: spec.instanceName,
        // 04 §7 时刻④: `ref@digest`, not a tag. Steps ①②③ freeze a coordinate into
        // the database; if the string handed to the daemon here is still a tag, all
        // three were bookkeeping — 「不可变坐标」只在最后交给 provider 的那个字符串
        // 是 digest 时才成立. Degrades to the bare tag for a pre-slice sandbox row
        // whose digest is not recoverable.
        Image: pinnedImageRef(spec.image),
        // ⚠️ NO `Cmd`. The AIO image ships its own entrypoint, and that entrypoint is
        // what starts the agent on `:8080` — overriding it with a keep-alive command
        // would leave a container that is "running" and permanently unreachable.
        Tty: false,
        OpenStdin: false,
        Labels: { ...spec.labels },
        Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        ExposedPorts: { [portKey]: {} },
        HostConfig: {
          Binds: binds.length ? binds : undefined,
          Memory: spec.quota.ramMb * 1024 * 1024,
          NanoCpus: Math.round(spec.quota.cores * 1e9),
          AutoRemove: false,
          // ⚠️ **官方把它标为必需**（AIO Sandbox 的 `docker run` 文档与 k8s 清单里都有）。
          // 镜像内的 Chrome / VNC / 那套桌面栈要用到默认 seccomp profile 拦掉的系统调用
          // （`clone` 的若干 namespace 位、`ptrace`），少了它那些子系统起不来。
          //
          // ⚠️ **诚实登记它的代价，而不是抄一句 "required" 就完事**：这一条**放宽了
          // 容器的隔离**。平台跑的是 LLM 生成的代码，所以隔离在这里是安全边界。缓解在
          // 别处：一个 Task 一个实例（ADR 决策 C「隔离粒度」——aio 的 session 不隔离
          // 文件系统，所以不能用 session 分）、agent 端口只发布到 loopback 且有
          // `SANDBOX_API_KEY` 把门、以及内存/CPU 配额。
          //
          // ⚠️ 实测（2026-08-29，v1.11.0）：**不加它，bash / tmux / codex / claude 这条
          // 主路径照常工作**。也就是说这一条买的是 browser 那一档的可用性，不是主路径的。
          // 记在这里是为了将来有人想去掉它时，知道该验的是哪一块，而不是「试试看没炸」。
          SecurityOpt: ['seccomp=unconfined'],
          // ── 两种坐标，二选一（`agent-addressing.ts`，shared/11 §1.4）──────────
          //
          // `container-network`：api 与沙箱同在一个用户自定义网络 ⇒ 走 docker 内嵌
          // DNS，**一个端口都不发布**。这是本形态相对默认档**收窄**暴露面的那一半：
          // 宿主上没有任何进程能碰到这个 `:8080`。
          //
          // `published-port`（默认）：发布到 LOOPBACK ONLY（HostIp 127.0.0.1），
          // 永不发布到对外网卡。loopback 本身**不是**访问控制——本机每个进程都共享它
          // ——所以 agent 另有一道 `SANDBOX_API_KEY` 的门（ADR 安全姿态）。
          // 空 HostPort = 内核分配的临时端口，起容器时才定。
          ...(network !== null
            ? { NetworkMode: network }
            : { PortBindings: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: '' }] } }),
        },
      });
      return container.id;
    });
  }

  async start(id: string): Promise<void> {
    return this.guard(async () => {
      try {
        await this.docker.getContainer(id).start();
      } catch (e) {
        // already started — idempotent (04 §2.2)
        if (this.statusCode(e) !== 304) throw e;
      }
    });
  }

  async stop(id: string, opts?: { timeoutSec?: number }): Promise<void> {
    return this.guard(async () => {
      try {
        await this.docker.getContainer(id).stop({ t: opts?.timeoutSec ?? 10 });
      } catch (e) {
        if (this.statusCode(e) === 304) return; // already stopped
        throw e;
      }
    });
  }

  async destroy(id: string): Promise<void> {
    return this.guard(async () => {
      try {
        await this.docker.getContainer(id).remove({ force: true });
      } catch (e) {
        if (this.statusCode(e) === 404) return; // already gone — idempotent (04 §2.2)
        throw e;
      }
    });
  }

  async inspect(id: string): Promise<SandboxRuntimeStatus> {
    try {
      const info = await this.docker.getContainer(id).inspect();
      return {
        lifecycleState: mapState(info.State?.Status, info.State?.Running),
        exitCode: info.State?.ExitCode,
        startedAt: info.State?.StartedAt,
        finishedAt: info.State?.FinishedAt,
        raw: info.State,
      };
    } catch (e) {
      // inspect must distinguish "confirmed missing" from "can't reach" (04 §2.2)
      if (this.statusCode(e) === 404) return { lifecycleState: 'instance_missing' };
      throw this.toProviderError(e);
    }
  }

  /**
   * 沙箱内 agent 的 HTTP origin —— **按部署形态给出两套坐标之一**（`agent-addressing.ts`）。
   *
   * | 形态 | 返回 | 谁解得开 |
   * |---|---|---|
   * | `container-network` | `http://<容器名>:<agentPort>` | 同一个用户自定义网络里的容器（docker 内嵌 DNS） |
   * | `published-port`（默认） | `http://127.0.0.1:<发布端口>` | **宿主上的进程** |
   *
   * ⚠️ **每次现算，从不持久化**（13 §）：端口是运行时分配的，名字则由运行时自己复述
   * （用 `info.Name` 而不是在这里重新拼一遍 `platform-<provider>-<id>` —— 拼的那一份
   * 早晚会与 provider 里的那一份漂移，而漂移的症状是「连不上」，不是「不一致」）。
   */
  async agentOrigin(id: string, agentPort: number): Promise<string> {
    const info = await this.guard(() => this.docker.getContainer(id).inspect());
    const network = this.network();
    if (network !== null) {
      // 不在这个网络上 ⇒ 名字解析不出来。这**必须**是一条指名道姓的错误：否则症状是
      // 一次 `did not become ready` 超时，而那条消息会把人送去查沙箱镜像（§1.4 实测：
      // 容器 healthy、平台连不上，两天才找到根因在地址上）。
      const attached = info.NetworkSettings?.Networks?.[network];
      if (attached === undefined) {
        throw new SandboxProviderError(
          SandboxProviderErrorCode.INVALID_STATE,
          `container ${id} is not attached to the docker network '${network}' ` +
            `(SANDBOX_DOCKER_NETWORK), so its name cannot be resolved from this process. ` +
            `Attached networks: ${Object.keys(info.NetworkSettings?.Networks ?? {}).join(', ') || '(none)'}.`,
        );
      }
      return `http://${(info.Name ?? '').replace(/^\//, '')}:${String(agentPort)}`;
    }
    const mapping = info.NetworkSettings?.Ports?.[`${agentPort}/tcp`]?.[0];
    if (!mapping?.HostPort) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        `agent port ${agentPort} is not published for container ${id}`,
      );
    }
    const host = mapping.HostIp && mapping.HostIp !== '0.0.0.0' ? mapping.HostIp : '127.0.0.1';
    return `http://${host}:${mapping.HostPort}`;
  }

  /** 配了网络名就返回它，否则 `null`（= 默认的发布端口坐标）。 */
  private network(): string | null {
    return this.addressing.mode === 'container-network' ? this.addressing.network : null;
  }

  private statusCode(e: unknown): number | undefined {
    return typeof e === 'object' && e !== null && 'statusCode' in e
      ? (e as { statusCode?: number }).statusCode
      : undefined;
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
    const code = this.statusCode(e);
    const msg = e instanceof Error ? e.message : String(e);
    // ⚠️ A 404 ABOUT A DIGEST-PINNED IMAGE IS ITS OWN FAILURE, NOT `NOT_FOUND`.
    // Pinning created this mode: the coordinate is exactly right and the bits behind
    // it were deleted or GC'd upstream (the tag may still resolve fine). Neither a
    // retry nor a corrected address helps — the way out is [检查更新] onto a new
    // digest, so the user's action differs and therefore so must the code
    // (04 §4 四类分类法). Tested BEFORE the generic 404 rule, which would swallow it.
    if (code === 404 && /@sha256:/.test(msg)) {
      return new SandboxProviderError(SandboxProviderErrorCode.IMAGE_DIGEST_GONE, msg, e);
    }
    if (code === 404) {
      return new SandboxProviderError(SandboxProviderErrorCode.NOT_FOUND, msg, e);
    }
    if (code === 409) {
      return new SandboxProviderError(SandboxProviderErrorCode.ALREADY_EXISTS, msg, e);
    }
    // ECONNREFUSED / ENOENT on the socket ⇒ daemon unreachable (04 §4)
    if (/ECONNREFUSED|ENOENT|EAI_AGAIN|socket hang up/i.test(msg)) {
      return new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        `docker daemon unreachable: ${msg}`,
        e,
        true,
      );
    }
    return new SandboxProviderError(SandboxProviderErrorCode.INTERNAL, msg, e);
  }
}

function mapState(status?: string, running?: boolean): SandboxRuntimeLifecycleState {
  if (running) return 'instance_running';
  switch (status) {
    case 'created':
      return 'instance_creating';
    case 'paused':
      return 'instance_paused';
    case 'exited':
      return 'instance_exited';
    case 'dead':
      return 'instance_dead';
    default:
      return 'instance_missing';
  }
}
