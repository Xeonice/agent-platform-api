import type {
  ResolvedImageSpec,
  ResourceQuota,
  SandboxRuntimeStatus,
  VolumeMount,
} from '@platform/contracts';

/**
 * 容器**控制面**端口 —— 只有 create/start/stop/destroy/inspect 这一组。
 *
 * ══ 为什么要有这个接口（② 控制面收窄）══════════════════════════════════════════
 *
 * 这里曾经没有接口，只有一个 `AioSandboxProvider extends DockerContainerBackend`。
 * 继承把两件毫无关系的事焊死了：
 *
 *   · **控制面**——「谁来起这个实例」：docker / podman / k8s Pod / 远程主机；
 *   · **数据面**——「怎么在实例里跑东西」：AIO 镜像自带的那套 HTTP/WS API。
 *
 * 数据面**根本不关心**控制面是谁：它只需要一个能打到 `:8080` 的 origin。而 `extends`
 * 让 `aio` 这个方案在类型上**就是**一个 docker 后端——想换 podman 就得改继承链，
 * 而继承链上挂着的是数据面代码。⚠️ 这也正是 boxlite 用组合而不是继承的原因：
 * 它的控制面是 BoxLite SDK，数据面是 native exec，两者各自可换。
 *
 * ⇒ `AioSandboxProvider` 现在**注入**一个 `ContainerRuntime`，`DockerContainerRuntime`
 * 是它今天唯一的实现。契约测试（`runSandboxProviderContractTests`）打的是 provider，
 * 不是这个端口——这个端口不是对外契约，是模块内部的接缝。
 *
 * ⚠️ **数据面绝不出现在这个接口上**：没有 `exec`、没有 `spawn`、没有 `copyTo`。
 * 加进来一个，下一个实现就得回答「podman exec 和 AIO 的 `/v1/bash/exec` 语义一样吗」
 * ——而答案是不一样（04 §2.3：`docker exec` 没有 `hard_timeout`、没有 job 存活语义）。
 * 「从外面撬进实例」的通道一旦存在，就会有人用它绕过沙箱自己的接口。
 */
export interface ContainerRuntime {
  /** 用于错误消息与诊断的运行时名字（`docker`）。不参与任何分支判断。 */
  readonly kind: string;

  /**
   * 起一个**未启动**的实例，返回运行时侧的 id。
   *
   * ⚠️ 返回 id 而不是 handle：`SandboxHandle`（含 `providerState`）是 **provider** 的
   * 词汇，控制面不知道也不该知道里面装的是什么（`agent-state.ts`）。
   */
  create(spec: ContainerCreateSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string, opts?: { timeoutSec?: number }): Promise<void>;
  destroy(id: string): Promise<void>;
  /** ⚠️ 必须区分「确认不存在」（`instance_missing`）与「够不着」（抛错），见 04 §2.2。 */
  inspect(id: string): Promise<SandboxRuntimeStatus>;

  /**
   * 沙箱内 agent 端口在**宿主侧**可达的 HTTP origin（`http://127.0.0.1:<port>`）。
   *
   * ⚠️ **每次现算，从不持久化**（13 §）：端口是运行时分配的，重启后由运行时自己
   * 重新回答。这是它与凭证的关键区别——凭证反推不出来，所以那个才落库。
   */
  agentOrigin(id: string, agentPort: number): Promise<string>;
}

export interface ContainerCreateSpec {
  readonly sandboxId: string;
  /**
   * 运行时侧的实例名（`platform-aio-<sandboxId>`）。
   *
   * ⚠️ 由 **provider** 拼、不是运行时拼：名字里的 `aio` 是**方案**名，而运行时不知道
   * 自己在给哪个方案干活——同一个 `DockerContainerRuntime` 将来可以同时服务两个方案。
   */
  readonly instanceName: string;
  readonly image: ResolvedImageSpec;
  readonly env: Readonly<Record<string, string>>;
  /** 平台语义的标签（`platform.*` + 实例位），运行时原样贴上、不解释。 */
  readonly labels: Readonly<Record<string, string>>;
  readonly quota: ResourceQuota;
  readonly volumes: readonly VolumeMount[];
  /**
   * 沙箱内 agent 监听的 TCP 端口。运行时必须把它发布到**宿主 loopback**
   * （`127.0.0.1`，端口由内核分配），永远不发布到对外网卡。
   *
   * ⚠️ loopback 本身**不是**访问控制——本机任意进程都够得着；那把锁是
   * `SANDBOX_API_KEY`（`agent-auth.ts`）。两者缺一不可：只有 key 没有 loopback，
   * 端口就暴露在网上；只有 loopback 没有 key，就是给本机所有进程开的一个 shell。
   */
  readonly agentPort: number;
}
