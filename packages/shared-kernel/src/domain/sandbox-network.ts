/**
 * `SANDBOX_DOCKER_NETWORK` —— **全仓唯一的读取点**（shared/11 §1.4）。
 *
 * 它不是「一个网络名」，而是一句**关于部署形态的声明**：
 *
 *   「沙箱容器放到这个网络里，**而我（api 进程）自己也在这个网络里**。」
 *
 * 两件事必须同时为真，所以它们由同一个配置表达。⚠️ 但「由同一个配置表达」不等于
 * 「两件事都被检查了」：`DockerContainerRuntime.agentOrigin` 查的一直只是**沙箱容器**
 * 在不在网络上——而那一半是平台自己放进去的，**填不错**。真正会填错的是后半句，
 * 由 `docker/self-network-check.ts` 在**开机时**验（2026-08-30 实测补上：不验的后果是
 * 沙箱静静卡在 `starting` 六分钟以上，无错误、无超时、无一行日志）。
 *
 * ── 为什么读取点要收成一个 ──────────────────────────────────────────────────
 * 与 `builtin-image.ts` 同源的教训：同一个 env 被两处各自读、各自兜底，结果是两条
 * 提示指向两个不同的下一步。这里的第二个读者是 `ImageSeeder`——播种失败时那句
 * 「下一步」在两种形态下**不一样**（裸跑：registry 起没起；compose：坐标在容器里
 * 解析得开吗），它必须知道自己站在哪一档。
 *
 * ⚠️ **空串必须算「没配」**：`SANDBOX_DOCKER_NETWORK=` 是 compose / `.env` 里表达
 * 「我没填」最常见的写法。把它当成一个名叫空字符串的网络，会让容器创建直接失败。
 */
export function configuredSandboxNetwork(env: NodeJS.ProcessEnv = process.env): string | null {
  const network = (env.SANDBOX_DOCKER_NETWORK ?? '').trim();
  return network === '' ? null : network;
}
