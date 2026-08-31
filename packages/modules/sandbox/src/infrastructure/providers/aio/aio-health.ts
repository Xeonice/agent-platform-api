import type { HealthStatus } from '@platform/contracts';

/**
 * aio 的**零成本**健康信号（03 §7.8 分层探测的第一层）。
 *
 * ── ⛔ 为什么不直接用镜像自带的 `HEALTHCHECK` ────────────────────────────────
 * AIO 镜像自带 HEALTHCHECK，`docker inspect` 的 `State.Health` 确实**可读**（含
 * `Log` 与 `FailingStreak`），读它也不进沙箱。**但照抄它会把好沙箱判死**，实测
 * 2026-08-27（`platform/sandbox:v2`，默认参数）：
 *
 * | 端口 | 谁在看它 | 实测 |
 * |---|---|---|
 * | `8091` `SANDBOX_SRV_PORT` | 镜像 HEALTHCHECK | 在听 ✅ |
 * | `9222` 浏览器调试口 | 镜像 HEALTHCHECK | **没起** ❌ ← unhealthy 的唯一原因 |
 * | `8080` `PUBLIC_PORT` | **平台自己**（`agentPort: 8080`） | HTTP 200，exec 回 0 ✅ |
 *
 * ⇒ 60s 后 `State.Health = unhealthy`（`FailingStreak = 10`），而同一时刻沙箱**完全
 * 可用**。三条结论：① 它探的口 ≠ 平台用的口；② 它比平台的关心面更严格，多押一个浏览器，
 * 而 `docker-container-backend` 创建容器时**不设** `DISABLE_BROWSER` ——「浏览器没起就
 * unhealthy」是默认路径下的**常态，不是边缘情况**；③ 语义因此是单向的：`healthy` ⇒
 * agent 可用（充分条件），`unhealthy` ⇏ agent 不可用。
 *
 * 还有一条时间上的硬伤：`Retries 8 × Interval 10s` ⇒ Docker 自己认定 unhealthy
 * **最长要 80 秒**，比 30s 采样周期还慢，承担不了抗抖动。
 *
 * ⇒ **判据是平台自己关心的 8080（一次免鉴权的 `GET /v1/ping`）；`State.Health` 只作
 * 辅助信号与诊断详情**，进 `message`，不进判定。
 */
export interface AioHealthInputs {
  /** `GET :8080/v1/ping` 是否 200 —— 平台真正用的那扇门。`undefined` = 没问出来。 */
  agentReachable: boolean | undefined;
  /** `docker inspect` 的 `State.Health.Status`，**仅作诊断详情**。 */
  dockerHealth?: string;
  /** `State.Health.FailingStreak`，同样仅作诊断详情。 */
  dockerFailingStreak?: number;
  /** 容器在不在跑。 */
  running: boolean;
  at: string;
}

export function readAioHealth(input: AioHealthInputs): HealthStatus {
  const aux =
    input.dockerHealth === undefined
      ? ''
      : ` (docker State.Health=${input.dockerHealth}` +
        `${input.dockerFailingStreak === undefined ? '' : `, failingStreak=${String(input.dockerFailingStreak)}`}` +
        '; auxiliary only — it watches 8091+9222, the platform uses 8080)';

  if (!input.running) {
    return {
      state: 'unhealthy',
      lastCheckedAt: input.at,
      message: `container is not running${aux}`,
      consecutiveFailures: 1,
    };
  }
  if (input.agentReachable === undefined) {
    // ⚠️ 问不出来 ≠ 不健康。`unknown` 是**没问出来**，把它读成 `unhealthy` 会让一次
    // 网络抖动看起来像沙箱挂了（同 04 §11「不知道不是 false」）。
    return {
      state: 'unknown',
      lastCheckedAt: input.at,
      message: `agent :8080 /v1/ping could not be reached to a conclusion${aux}`,
      consecutiveFailures: 0,
    };
  }
  return {
    state: input.agentReachable ? 'healthy' : 'unhealthy',
    lastCheckedAt: input.at,
    message: `agent :8080 /v1/ping ${input.agentReachable ? 'ok' : 'failed'}${aux}`,
    // ⚠️ 一次 ping 只有 0/1 —— 跨采样的抗抖动计数住在 `SandboxHealthMonitor` 里。
    consecutiveFailures: input.agentReachable ? 0 : 1,
  };
}
