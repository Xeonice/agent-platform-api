import type { HostCapacity } from '../services/resource-pool.domain-service';

/**
 * 「这台机器有多少资源」的探测口（03 §1「启动时探测宿主机资源」/「探测：`statfs(DATA_ROOT)`」）。
 *
 * ⚠️ **它是一个端口而不是一个 `os.cpus()` 调用**，理由只有一个：调度判定必须能被**穷举
 * 单测**。把探测写死在服务里，「盘只剩 1MB」「16 核全被占满」这些格子就只能靠真机复现
 * ——也就是永远不会被测到，而它们恰恰是这段代码存在的全部理由。
 */
export interface HostCapacityProbe {
  capacity(): Promise<HostCapacity>;
}

export const HOST_CAPACITY_PROBE = Symbol('HostCapacityProbe');
