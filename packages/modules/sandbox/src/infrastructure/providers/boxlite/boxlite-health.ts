import type { HealthStatus } from '@platform/contracts';

/**
 * boxlite 的**零成本**健康信号（03 §7.8 分层探测的第一层）。
 *
 * ── 为什么是零成本，以及为什么这一点是全部前提 ────────────────────────────────
 * ⛔ **只读探测也可能是致命的。** 2026-08 排障里，`probeOnPath` 那条 `codex --version`
 * **把整个沙箱的 agent 打挂了** —— 一次意在「检查」的调用摧毁了被检查的对象。所以任何
 * 周期性健康检查，先回答代价。
 *
 * 实测（2026-08-27，boxlite 0.9.7 / arm64）：`box.info()` **0ms**（纯本地状态）、
 * `box.metrics()` **0.1ms**（×10 均值），两者**都不进沙箱**；而 native `exec` 是
 * 85–592ms 且**真的进去**。⇒ 常态每 30s 只用前两个，后者留给「有异常迹象时确认一次」。
 *
 * ── 判据 ────────────────────────────────────────────────────────────────────
 * ① `info().state.running === false` ⇒ `unhealthy`（VM 都不在跑，没什么好商量的）。
 * ② `info().healthStatus` 是 BoxLite **自己**的健康检查（`None|Starting|Healthy|
 *    Unhealthy` + `failures`）。它零成本可读，直接映射。
 * ③ `metrics().execErrorsTotal` 是一个**零成本的异常指示器** —— 不进沙箱就能知道
 *    「最近有没有 exec 出错」。⚠️ 它是**累计值**，单次采样说明不了任何事；有意义的是
 *    **相对上次采样的增长**，所以这里只把它原样带出去，由 `SandboxHealthMonitor`
 *    做差分。在这里就地判「>0 即不健康」会把一个开机以来出过一次错的健康沙箱判死。
 *
 * ⚠️ `consecutiveFailures` 在这一层是 **BoxLite 自己**那把计数器，不是平台的抗抖动
 * 计数（后者跨采样，住在 monitor 里）。同形不同源。
 */
export interface BoxliteHealthInputs {
  running: boolean;
  state: { state: string; failures: number; lastCheck?: string };
  /** `metrics()` 拿不到时缺席 —— 缺席不退化成 0（0 是「一次都没错过」，是个断言）。 */
  execErrorsTotal?: number;
  /** 采样时刻（`Clock` 给的 ISO 串；基础设施层不读墙钟，01 §3）。 */
  at: string;
}

export interface BoxliteHealthReading {
  health: HealthStatus;
  /** 原样带出，供 monitor 做「相对上次采样的增长」这个差分。 */
  execErrorsTotal?: number;
}

export function readBoxliteHealth(input: BoxliteHealthInputs): BoxliteHealthReading {
  const lastCheckedAt = input.state.lastCheck ?? input.at;
  const failures = Number.isFinite(input.state.failures) ? Math.max(0, input.state.failures) : 0;
  if (!input.running) {
    return {
      health: {
        state: 'unhealthy',
        lastCheckedAt,
        message: 'box is not running (info().state.running === false)',
        // VM 不在跑是一次确凿的失败，哪怕 BoxLite 自己的计数器还是 0
        consecutiveFailures: Math.max(failures, 1),
      },
      execErrorsTotal: input.execErrorsTotal,
    };
  }
  return {
    health: {
      state: mapBoxliteState(input.state.state),
      lastCheckedAt,
      message: `boxlite healthStatus=${input.state.state}`,
      consecutiveFailures: failures,
    },
    execErrorsTotal: input.execErrorsTotal,
  };
}

/**
 * `JsHealthState` → 契约的 `HealthState`。
 *
 * ⚠️ **`None` 映射成 `unknown`，不是 `healthy`。** `None` 的意思是「这张镜像没有配
 * health check」——**没问出来**，不是「问了，答健康」。把它读成 healthy 就是替 provider
 * 编一个它没说过的答案（同 04 §11 `imageStaged`「不知道不是 false」那条纪律）。
 */
function mapBoxliteState(state: string): HealthStatus['state'] {
  switch (state.toLowerCase()) {
    case 'healthy':
      return 'healthy';
    case 'unhealthy':
      return 'unhealthy';
    case 'starting':
      return 'starting';
    default:
      return 'unknown';
  }
}
