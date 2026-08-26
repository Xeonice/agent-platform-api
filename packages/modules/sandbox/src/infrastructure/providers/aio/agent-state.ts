import type { SandboxHandle } from '@platform/contracts';

/**
 * 「数据面走 in-sandbox HTTP agent」的那类 provider 的**私有** state 形状。
 *
 * ⚠️ **这两个键是 provider 私有的，不是平台词汇。** 契约上只有一个不透明的
 * `SandboxHandle.providerState`（平台原样存、原样还、从不解释）；把它解释成
 * 「端口 + bearer token」是**这一类实现**的事，所以这个文件住在 `aio/` 下而不是
 * 契约包里。用 native 通道的 provider（boxlite 微 VM）不需要其中任何一个。
 *
 * 历史：这两个键曾经是 `SandboxHandle` 上的具名字段 `agentEndpointPort` /
 * `agentAuthToken`，一路穿透到 `Sandbox` 聚合和 `sandboxes` 表。收回来的理由见
 * `providerState` 的注释。
 */
export interface AgentProviderState {
  /**
   * agent 的 bearer 凭证。无法从运行时反推（容器只持有公钥那一半），丢了就等于
   * 跨重启丢掉数据面。⚠️ 含密：随 `provider_state` 落库，不进日志、不上 DTO。
   */
  readonly agentAuthToken?: string;
  /**
   * 转发到宿主 loopback 的 agent 端口。boxlite 需要记住它（BoxLite 的 `getInfo`
   * 不暴露端口映射，重启后推不回来）；aio 不需要——它每次从 `docker inspect` 重解。
   */
  readonly agentEndpointPort?: number;
}

/** 从不透明的 `providerState` 里**收窄**出本类 provider 认识的那几个键。 */
export function readAgentState(handle: SandboxHandle): AgentProviderState {
  const s = handle.providerState;
  if (s === undefined) return {};
  const token = s['agentAuthToken'];
  const port = s['agentEndpointPort'];
  return {
    agentAuthToken: typeof token === 'string' ? token : undefined,
    agentEndpointPort: typeof port === 'number' ? port : undefined,
  };
}

/**
 * 组装成契约要的形状。
 *
 * ⚠️ **`undefined` 的键不写进去**：`provider_state` 是一列 JSON，
 * `{"agentAuthToken":null}` 与「没有这个键」在读回来时同义，但前者会让落库的内容
 * 看起来像"有这么个东西、值是空"——排查时多一次误导。
 */
export function agentProviderState(state: AgentProviderState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (state.agentAuthToken !== undefined) out['agentAuthToken'] = state.agentAuthToken;
  if (state.agentEndpointPort !== undefined) out['agentEndpointPort'] = state.agentEndpointPort;
  return out;
}
