import type { SandboxHandle } from '@platform/contracts';
import type { ExecCapableBox } from './boxlite-runtime';

/**
 * 「把一个 `SandboxHandle` 变成一个可用的 Box 句柄」——数据面三个实现（spawn /
 * files / jobs）唯一需要 provider 提供的东西。
 *
 * ⚠️ **每次调用都必须重新 `runtime.get(id)`，不许缓存 Box 对象。** 实测：
 * `box.stop()` 之后旧句柄就废了，再用它 exec 会抛
 * `stopped: Handle invalidated after stop(). Use runtime.get() to get a new handle.`
 * 而沙箱的 `stopped → starting` 复用（03 §4）是常规路径，不是异常路径。
 *
 * 反过来这也是 boxlite 不再需要 `providerState` 的原因：**只凭 box id 就能在一个
 * 全新的进程里接回运行中的 Box**（实测：进程 A 建 detached box，进程 B `rt.get(id)`
 * 后 exec 成功，`stop()→start()` 之后 rootfs 内容仍在）。旧实现要持久化
 * `agentEndpointPort` + `agentAuthToken`，是因为**沙箱内 HTTP agent** 的可达地址推不
 * 回来；native 通道没有地址这回事。
 */
export type BoxFor = (handle: SandboxHandle) => Promise<ExecCapableBox>;
