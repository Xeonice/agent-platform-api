/**
 * **平台自己站在哪一侧** —— 沙箱内 agent 的可达地址该用哪一套坐标（shared/11 §1.4）。
 *
 * ══ 它修的是什么 ═══════════════════════════════════════════════════════════════
 *
 * 两条各自正确的决定曾经撞在一起，撞出一个「容器 healthy、平台却连不上」的死局：
 *
 * | 决定 | 落点 | 后果 |
 * |---|---|---|
 * | agent 端口**只发布到 loopback**（安全加固） | `PortBindings: [{ HostIp: '127.0.0.1' }]` | 端口只出现在**宿主**的 netns |
 * | `agentOrigin` 照着 `HostIp` 拼回调地址 | `http://127.0.0.1:<port>` | 这个地址**只有宿主上的进程**解得开 |
 *
 * DooD 下 api 请求的是**宿主的** docker daemon ⇒ 端口发布在宿主 loopback；而 api 自己
 * 在容器里，它的 `127.0.0.1` 是**容器自己的** loopback ⇒ 永远连不上。实测（2026-08-29，
 * 真 Linux）：容器 `Up (healthy) 127.0.0.1:45995->8080/tcp`，而建 Task 必定
 * `PROVIDER_UNAVAILABLE: in-sandbox agent at http://127.0.0.1:45171 did not become ready`。
 *
 * ⚠️ 这与 §1.2「宿主路径 = 容器路径」是**同一类**问题的两面：DooD 下 api 说出口的每一个
 * 坐标（路径、地址）都由**宿主**解析。路径那一条早就记下来了，地址这一条没有。
 *
 * ══ 为什么是显式配置，不是探测 ═══════════════════════════════════════════════════
 *
 * ⛔ **不用 `/.dockerenv`、不用 cgroup、不用「能不能 ping 通网关」这类探测。** 探测回答的
 * 是「我像不像在容器里」，而真正要回答的问题是「**我说出口的地址，对面照着它解析得开吗**」
 * —— 那取决于部署者怎么接的网，不取决于我在不在容器里。反例现成：api 在容器里但用
 * `network_mode: host`，`/.dockerenv` 在、而 loopback 那套坐标恰恰是**对的**。
 *
 * 一个探测错了的部署，症状是「健康检查全绿、建 Task 必失败」——最难查的那一种。而显式
 * 配置错了，症状是一条指名道姓的错误（见 `DockerContainerRuntime.agentOrigin`）。
 *
 * ⇒ **一个配置项 `SANDBOX_DOCKER_NETWORK`，默认空 = 今天的行为，一字不差。**
 *
 * | 值 | 形态 | 端口 | `agentOrigin` |
 * |---|---|---|---|
 * | 空（默认） | api **裸跑在宿主**（§1.3 实测全绿的那条） | 发布到宿主 loopback | `http://127.0.0.1:<发布端口>` |
 * | 网络名 | api **在容器里**，与沙箱同在这个用户自定义网络 | **完全不发布** | `http://<容器名>:8080` |
 *
 * ⚠️ **它是一句声明，不是一个开关**：填了网络名，等于部署者说「沙箱放到这个网络里，
 * 而我自己也在这个网络里」。这两件事必须同时为真——所以它们由**同一个**配置表达，
 * 而不是两个可以各自填错的配置。
 *
 * ⚠️ **顺带把暴露面收得比默认还小**：容器名走的是 docker 内嵌 DNS，沙箱的 `:8080`
 * **一个端口都不必发布到宿主**。`SANDBOX_API_KEY` 那道门不因此撤掉（同网络的其他容器
 * 仍够得着），但「本机任意进程都够得着」这一条没有了。
 */
export type AgentAddressing =
  | { readonly mode: 'published-port' }
  | { readonly mode: 'container-network'; readonly network: string };

/**
 * 从 `SANDBOX_DOCKER_NETWORK` 读出形态。**空串 / 未设 = `published-port`**。
 *
 * ⚠️ 空串必须算「没配」：`SANDBOX_DOCKER_NETWORK=` 在 compose 里是「我没填」的常见写法，
 * 把它当成一个名叫空字符串的网络会让容器创建直接失败（与 `isBuiltinImageConfigured`
 * 的那条 ⚠️ 同源）。
 */
export function resolveAgentAddressing(env: NodeJS.ProcessEnv = process.env): AgentAddressing {
  const network = (env.SANDBOX_DOCKER_NETWORK ?? '').trim();
  return network === '' ? { mode: 'published-port' } : { mode: 'container-network', network };
}

/**
 * 容器名能不能被 docker 内嵌 DNS 解析出来 —— 一个 DNS label 的形状。
 *
 * ⚠️ **这条检查存在的理由是「不可达」没有别的症状**。容器名今天是
 * `platform-aio-<sandboxId>`，而 `sandboxId` 是 UUID ⇒ 49 字符、全小写、只有连字符，
 * 稳定合法。但「今天合法」不是「永远合法」：换一个 id 生成器（带下划线、带大写、
 * 更长）或换一个 provider 名，名字就可能不再是一个 DNS label —— 而那时容器**照样起得来**，
 * 只是 `http://<名字>:8080` 永远连不上，报出来是一条 `did not become ready`，
 * 指向沙箱而不是指向名字。⇒ 在 `create` 的门口就拦，把它变成一条说得出原因的错误。
 *
 * RFC 1123：1–63 字符，`[a-z0-9]` 开头结尾，中间可含连字符。大写字母 docker 允许放进
 * 容器名，但 DNS 查询大小写不敏感、而部分解析路径会原样比对 —— 不冒这个险。
 */
export function isDnsResolvableContainerName(name: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name);
}
