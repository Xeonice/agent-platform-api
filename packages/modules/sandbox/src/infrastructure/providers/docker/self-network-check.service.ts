import { networkInterfaces } from 'node:os';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type Docker from 'dockerode';
import { DOCKER_CLIENT } from './docker.token';
import { resolveAgentAddressing } from './agent-addressing';
import {
  describeSelfAttachment,
  localNetworkAddresses,
  matchSelfAmongMembers,
  membersOnNetwork,
  type SelfAttachment,
} from './self-network-check';

/**
 * **开机自检**：填了 `SANDBOX_DOCKER_NETWORK` 就在启动期证实「本进程真的在那个网络里」。
 * 判定与消息全在 `self-network-check.ts`（纯函数，可单测）；这里只负责取两侧的事实、
 * 决定失败的响度。
 *
 * ⚠️ **为什么必须在开机，而不是在第一个 Task**：不验的后果不是「第一个 Task 报错」，
 * 而是「第一个 Task 静静地卡住」——无错误、无超时、无日志（shared/11 §1.4，实测 6 分钟
 * 以上）。开机失败是这条配置唯一还能被看见的时刻。
 *
 * ⚠️ **它与 `RuntimeReconciler` 的「失败绝不阻断启动」是两类事，别照抄那条纪律**：
 * 对账失败意味着「有件维护工作没做成」，平台照样能干活；而这一条失败意味着**平台
 * 从现在起做的每一件事都会静静地失败**。前者少报是降级，后者少报是撒谎。
 *
 * ⚠️ **只有确凿的否定才拒绝启动**（`self-network-check.ts` 末尾那张表）：docker 够不着、
 * 本进程没有任何非回环地址——这些是「没能验证」，走 error 级别的日志而不是拒绝启动。
 * 静默放行才是被禁掉的那一种。
 */
@Injectable()
export class DockerSelfNetworkCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('DockerSelfNetworkCheck');

  constructor(@Inject(DOCKER_CLIENT) private readonly docker: Docker) {}

  async onApplicationBootstrap(): Promise<void> {
    const addressing = resolveAgentAddressing();
    // 没配 = 裸跑档，什么都不必验：那一档说出口的是宿主 loopback 坐标，而它由
    // 「端口真的发布出来了吗」自己把关（`agentOrigin` 的 not published 分支）。
    if (addressing.mode !== 'container-network') return;

    const local = localNetworkAddresses(networkInterfaces());
    const attachment = await this.probe(addressing.network, local);
    const outcome = describeSelfAttachment(addressing.network, attachment, local);
    if (outcome.level === 'fatal') throw new Error(outcome.message);
    // ⚠️ 「没能验证」走 **error** 而不是 warn：这条配置错了就是静默死机，一条被淹在
    // warn 里的提示等于没打。真正的 warn 疲劳问题见 `env.ts` 的 `describeBindExposure`。
    if (outcome.level === 'unverified') this.logger.error(outcome.message);
    else this.logger.log(outcome.message);
  }

  private async probe(network: string, local: readonly string[]): Promise<SelfAttachment> {
    if (local.length === 0) {
      return {
        kind: 'unverifiable',
        reason: '本进程没有任何非回环网络地址，无法与 daemon 的记录对表',
      };
    }
    let listed;
    try {
      // `GET /containers/json` —— socket-proxy 白名单里 CONTAINERS 已经开着的那条，
      // 不需要为一次自检去放开 NETWORKS（理由见 self-network-check.ts 文件头）。
      listed = await this.docker.listContainers({ filters: { network: [network] } });
    } catch (e) {
      return {
        kind: 'unverifiable',
        reason: `问不到 docker（${e instanceof Error ? e.message : String(e)}）`,
      };
    }
    return matchSelfAmongMembers(membersOnNetwork(listed, network), local);
  }
}
