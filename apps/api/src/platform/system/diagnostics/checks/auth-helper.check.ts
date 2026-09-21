import { Injectable } from '@nestjs/common';
import { HelperContainerSession } from '@platform/runtime';
import type { DiagnoseCheck, DiagnoseCheckResult } from './check.types';

/**
 * auth helper 容器是否就绪（11 §1.1 运行纪律里点名要的那一项）。
 *
 * ── 它修的是什么 ──────────────────────────────────────────────────────────────
 * §1.1 原文：「启动时**版本探测**并纳入诊断项：helper 里 CLI 缺失或版本不受支持要在
 * 系统状态页显性报出，**而不是等用户点登录才失败**」。在这一项存在之前，用户唯一能
 * 发现 helper 没起来的方式，就是去点「帐号登录」然后撞上一句
 * 「多半是这个 CLI 在这台机器上没能正常启动」—— ⛔ 而那句话指错了方向（真相通常是
 * 镜像还没拉下来，或者这台机器拉不动）。
 *
 * ── 为什么它不是 fail 而是 warn ───────────────────────────────────────────────
 * ⚠️ helper 不可用**只挡住「帐号登录」这一条路**：API Key 那条是短路的（不碰 CLI、
 * 不碰 helper），凭证已经配好的部署也照样能跑任务。把它报成 `fail` 会让一台**完全
 * 可用**的机器在系统状态页上显示红色 —— 那正是本仓反复在删的那种「恒响的告警」。
 *
 * ⛔ 反过来也不许报 `ok`：那会让「点了登录才发现」这件事原样留在原地。
 */
@Injectable()
export class AuthHelperCheck implements DiagnoseCheck {
  readonly id = 'auth-helper' as const;
  readonly label = '帐号登录环境';

  constructor(private readonly session: HelperContainerSession) {}

  run(): Promise<DiagnoseCheckResult> {
    return Promise.resolve(this.verdict());
  }

  /** ⚠️ 契约的 `run()` 是 async，而本项只读内存状态、没有任何 IO —— 拆开免得写一个
   *  没有 await 的 async 函数（lint 会红，而加 disable 只是把问题藏起来）。 */
  private verdict(): DiagnoseCheckResult {
    // ⚠️ 只读状态，**⛔ 不触发创建**。诊断是只读的：让「运行诊断」顺手去拉一张 4GB
    //    的镜像，会把一次「看看哪儿坏了」变成一次长时间阻塞的副作用操作。
    const s = this.session.status();

    if (s.ready) {
      return {
        status: 'ok',
        headline: '帐号登录可用',
        detailText:
          'auth helper 容器已就绪 —— 「帐号登录」会在它里面跑官方 CLI，' +
          '与任务沙箱用同一张镜像（因此 CLI 版本一致）。',
      };
    }

    if (s.starting) {
      return {
        status: 'info',
        headline: '登录环境准备中',
        detailText:
          'auth helper 容器正在创建 —— 首次通常是在拉那张预制镜像（约 4GB）。' +
          '这期间「帐号登录」会失败，API Key 不受影响。',
        nextStep: '等它拉完再点「帐号登录」；想看进度就看 api 容器的日志。',
      };
    }

    return {
      status: 'warn',
      headline: '帐号登录暂不可用',
      detailText:
        `auth helper 容器没起来${s.lastError === null ? '' : `：${s.lastError}`}。` +
        '⚠️ 只影响「帐号登录」这一条路 —— API Key 那条不碰 helper，已配好凭证的任务也照跑。',
      nextStep: '多半是预制镜像还没拉下来或这台机器拉不动；先看上面那项「预制镜像就绪」。',
      errorCode: 'PROVIDER_UNAVAILABLE',
    };
  }
}
