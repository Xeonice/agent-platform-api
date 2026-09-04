import type { ProviderRegistry } from '@platform/contracts';

/**
 * 一个 provider 跑在什么底座上 —— 诊断项判定「**谁需要它**」的唯一出处。
 *
 * ── 它修的是什么：一条无条件的「必须有 docker」 ──────────────────────────────
 * 2026-09-05 实测（macOS，默认档 boxlite）：第 ① 项在 docker 不在时报 ❌「容器运行时
 * 不可达」，第 ② 项报「微 VM 档位在此平台不适用」，第 ⑤ 项的建议是「`docker run` 一个
 * registry」。**三条一起把一个 boxlite 跑得好好的 mac 用户推向 docker**，而
 * `hostPreferredProvider()` 在 darwin 上返回的恰恰是 `boxlite`，官方也明确写着
 * 「no root, no background service」—— 那台机器上 docker **一个字节都不需要**。
 *
 * ⚠️ **判据必须挂在「谁需要它」上，而不是无条件要求某个依赖在。** 一个恒 ❌ 的检查项
 * 与一个恒 ⚠️ 的检查项是同一种失败：看久了没人看，还会把其余七项的可信度一起拉低。
 *
 * ⚠️ **权威是 registry，不是 `process.platform`。** 平台默认档由
 * `hostPreferredProvider()` 按宿主决定，但第三方 provider 用
 * `register(p, { default: true })` 仍然能把它移走（04 §8 的开放注册语义）。诊断照着
 * 平台再推一次等于造第二个真相源 —— 而两个真相源迟早会打架。
 */
export type Substrate = 'container' | 'micro-vm' | 'unknown';

/**
 * 内置两个 provider 各自的底座。
 *
 * ⚠️ **第三方 provider 一律 `unknown`，不许猜。** 我们不知道一个外部 provider 靠什么跑
 * （远端集群？另一种 VMM？），把它当成 `container` 会让一台根本不需要 docker 的机器
 * 常年顶着一个 ❌；当成 `micro-vm` 则会在真正缺 docker 时闭嘴。「不知道」既不是「好」
 * 也不是「坏」—— 与 reflink 三态、内存 `unmeasurable` 同一条纪律（P21-5 §9D/§9E）。
 *
 * ⛔ 这里**不**用 `capabilities` 位来推：04 §2.5 只在「有平台分支挂在上面」时才允许加位，
 * 而「要不要 docker」是部署事实、不是沙箱能力 —— 加一个 `require.docker` 位，API 调用方
 * 拿它什么也做不了。
 */
export function substrateOf(provider: string): Substrate {
  if (provider === 'aio') return 'container';
  if (provider === 'boxlite') return 'micro-vm';
  return 'unknown';
}

/** 当前默认档的名字 + 它的底座 —— 诊断文案里要把名字**原样说出来**，用户才对得上。 */
export function defaultSubstrate(registry: ProviderRegistry): {
  provider: string;
  substrate: Substrate;
} {
  const provider = registry.defaultProvider;
  return { provider, substrate: substrateOf(provider) };
}
