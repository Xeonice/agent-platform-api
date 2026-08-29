import { Injectable } from '@nestjs/common';
import { SystemSettingsService } from '../../system-settings.service';
import { ConnectivityProbe } from '../connectivity.probe';
import type { DiagnoseCheck, DiagnoseCheckResult, DiagnoseContext } from './check.types';

/**
 * 诊断第 ⑤ 项：**外网连通**（镜像仓库 / 模型 API）。
 *
 * ⚠️ **模型 API 与镜像仓库的失败不是一回事**，这一项的分级完全建立在这条区分上：
 *   · 模型 API 全挂 ⇒ **Agent 不可用**，这是 P21-8 §1 的物理约束，不是配置问题 ⇒ ❌
 *   · 只是镜像仓库挂 ⇒ 拉不到新镜像，已经 staged 的照样能跑 ⇒ ⚠️
 * 合成一句「外网不通」会让一个只是内网镜像站没配好的部署被告知「Agent 将不可用」，
 * 而那句话会让人去查一件完全无关的事。
 *
 * ⚠️ **每一轮的结论都回写 `system_settings`**，于是 `GET /api/system/init-status` 附的
 * 「上次出网检测」总是最近一次真跑过的那次，而不是永远停在初始化那一刻。
 */
@Injectable()
export class OutboundNetworkCheck implements DiagnoseCheck {
  readonly id = 'outbound-network' as const;
  readonly label = '外网连通（模型 API / 镜像仓库）';

  constructor(
    private readonly probe: ConnectivityProbe,
    private readonly settings: SystemSettingsService,
  ) {}

  async run(ctx: DiagnoseContext): Promise<DiagnoseCheckResult> {
    const results = await this.probe.run({ timeoutMs: ctx.timeoutMs, signal: ctx.signal });
    this.settings.recordConnectivity(results);

    const modelApis = results.filter((r) => r.modelApi);
    const others = results.filter((r) => !r.modelApi);
    const failed = results.filter((r) => !r.ok);
    const detail = { results };

    if (failed.length === 0) {
      const fastest = Math.min(...results.map((r) => r.latencyMs ?? 0));
      return {
        status: 'ok',
        summary: `${results.map((r) => r.target).join('、')} 均可达（最快 ${String(fastest)}ms）`,
        detail,
      };
    }

    const line = failed.map((r) => `${r.target} 不可达`).join('、');
    if (modelApis.length > 0 && modelApis.every((r) => !r.ok)) {
      return {
        status: 'fail',
        summary: `${line} —— 模型 API 全部不可达，当前为离线环境，Agent 将不可用（P21-8 §1）`,
        hint: failed.find((r) => r.hint !== undefined)?.hint,
        detail,
      };
    }
    return {
      status: 'warn',
      summary:
        others.some((r) => !r.ok) && modelApis.every((r) => r.ok)
          ? `${line} —— 模型 API 正常，Agent 可用；但拉不到新镜像`
          : `${line} —— 部分目标不可达`,
      hint: failed.find((r) => r.hint !== undefined)?.hint,
      detail,
    };
  }
}
