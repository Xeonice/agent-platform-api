import { Injectable } from '@nestjs/common';
import { SystemSettingsService } from '../../system-settings.service';
import { ConnectivityProbe } from '../connectivity.probe';
import type { ConnectivityResult } from '@platform/contracts';
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
    // ⛔ **单个目标的预算必须明显小于整项预算** —— 此前这里直接把 `ctx.timeoutMs` 原样
    //    传下去，于是「每个目标最多等 5s」与「整项最多 5s」是同一个数：只要有一个目标
    //    真的要用满预算，**外层那个更早启动的计时器必然先到**，这一项就永远只能是
    //    「5 秒内没有结果 —— 这一项没有结论」。
    //
    // ⚠️ 那恰恰是最没用的结局，而且**只在最需要答案的时候出现**：网通的时候三个目标
    //    2 秒就回来了、结论好好的；网一出问题，用户想知道的正是「哪个不通」，
    //    而这一项在那一刻失声（2026-09-07 真机复现：截图里就是「超时未得出结论 5s」）。
    //
    // ⚠️ 留出的余量用来**把结论组装出来并回传**。超时的那个目标本来就会被报成
    //    「Xms 内无应答」（`probeOne` 的原话），而不是被说成「不可达」—— 慢与不通
    //    是两件事，这条纪律不受本次改动影响。
    const results = await this.probe.run({
      timeoutMs: perTargetBudget(ctx.timeoutMs),
      signal: ctx.signal,
    });
    this.settings.recordConnectivity(results);
    return outboundVerdict(results);
  }
}

/**
 * 逐条结果 → 这一项的结论。
 *
 * ⚠️ **抽成纯函数单独测**（与 `seedFailureNextStep` 同一条）：这里的分档全是**形态判断**
 * （谁是模型 API、谁超时、谁够不着），而形态判断最容易写出「看着对、少一档」的实现。
 * 纯函数让每一档都能被直接钉住，⛔ 不必为了测一句文案去造 `ConnectivityProbe` 的替身
 * ——那种替身还会逼出 `as unknown as` 双重断言（本仓 lint 禁止）。
 */
export function outboundVerdict(results: readonly ConnectivityResult[]): DiagnoseCheckResult {
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

  // ⚠️ **超时与够不着分开说** —— 「3.5 秒内没完成握手」证明不了「连不上」。
  const line = failed
    .map((r) => `${r.target} ${r.timedOut === true ? '未在预算内应答' : '不可达'}`)
    .join('、');

  if (modelApis.length > 0 && modelApis.every((r) => !r.ok)) {
    // ⛔ **全是超时时不宣布离线。** 真机实测（2026-09-07）同一个 `api.openai.com`，
    //    同一分钟内 TLS 握手在 1.0s / 1.8s / 6.1s 之间跳 —— 一条抖动的链路会周期性地
    //    越过探测预算，而 agent 的长连接在这种链路上工作正常。用一个几秒的探测预算去
    //    断言「Agent 将不可用」，是**断言一件它证明不了的事**：用户看着能正常干活的
    //    机器被告知不可用，而那条红条还会驱动向导要求他确认「以离线模式继续」。
    //
    // ⚠️ 真的够不着（连接被拒 / 解析不了 / 被重置）仍然是 ❌ 并宣布离线 —— 那一档
    //    的证据是确凿的。⇒ 分档的依据是**证据强度**，不是失败与否。
    if (modelApis.every((r) => r.timedOut === true)) {
      return {
        status: 'warn',
        summary:
          `${line} —— 模型 API 都没在探测预算内应答。**这不等于连不上**：` +
          '一条时快时慢的链路会周期性越过预算，而 agent 的长连接可能照样能用',
        hint:
          '重跑一次诊断看它是否稳定：偶发 ⇒ 多半只是慢；每次都这样 ⇒ 按不通处理' +
          '（企业内网常见形态是「网络通、但要走代理」，在系统设置里填 HTTPS_PROXY 后重试）',
        detail,
      };
    }
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
        : // ⚠️ `line` 里每条已经分别写了「不可达」还是「未在预算内应答」,
          //    这里的收尾句就不要再把它们压回同一个词。
          `${line} —— 部分目标未通过检查`,
    hint: failed.find((r) => r.hint !== undefined)?.hint,
    detail,
  };
}

/**
 * 单个目标的探测预算 —— 整项预算的 70%，且不低于 1s。
 *
 * ⚠️ 这是 `SEED_BUDGET_MS` 那条纪律的同一条（「预算必须**明显**小于调用方的耐心」），
 * 只是那次的调用方是人，这次是外面那层 `withTimeout`。**两层预算相等 = 内层永远说不出话。**
 */
export function perTargetBudget(checkBudgetMs: number): number {
  return Math.max(1_000, Math.round(checkBudgetMs * 0.7));
}
