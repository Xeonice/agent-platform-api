import { Injectable } from '@nestjs/common';
import type { SandboxRuntimeLifecycleState } from '@platform/contracts';
import { AUTH_HELPER_QUOTA, HelperContainerSession } from '@platform/runtime';
import type { DiagnoseCheck, DiagnoseCheckResult } from './check.types';

/** 失效之后的下一步。⛔ 没有后台自愈，所以要告诉人怎么立刻触发一次重建。 */
const REBUILD_NEXT_STEP =
  '下次帐号登录或凭证自动刷新时会自动重建；想立刻重建，发起一次「帐号登录」再取消即可。' +
  '重建失败的原因会显示在这里。';

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
 *
 * ── 为什么要问实例，而不只看句柄 ─────────────────────────────────────────────
 * ⚠️ 此前只看内存里的句柄是否非空：helper 的 VM 被杀、box 被删之后，这一项仍然报
 * 「帐号登录可用」。现在读 `observe()` —— 有句柄时问 provider 一次（`inspect`，只读）；
 * boxlite 的 `inspect` 对「记录还是 running、VM 已被杀」也会按 shim 进程核出 `instance_dead`
 * （Linux）。⛔ 没有后台自愈：失效之后要等下一次登录 / 刷新才重建，运维想立刻重建就发起一次
 * 帐号登录再取消。
 */
@Injectable()
export class AuthHelperCheck implements DiagnoseCheck {
  readonly id = 'auth-helper' as const;
  readonly label = '帐号登录环境';

  constructor(private readonly session: HelperContainerSession) {}

  async run(): Promise<DiagnoseCheckResult> {
    // ⚠️ 只读，**⛔ 不触发创建、也不重建**。诊断是只读的：让「运行诊断」顺手去拉一张 4GB
    //    的镜像，会把一次「看看哪儿坏了」变成一次长时间阻塞的副作用操作。失效的实例留给
    //    下一次真正的登录 / 刷新去重建。`observe()` 自己不抛（契约要求 `run()` 不抛）。
    const s = await this.session.observe();

    if (s.ready && s.stale === false) {
      return {
        status: 'ok',
        headline: '帐号登录可用',
        detailText:
          '帐号登录环境已就绪，会在独立环境中运行官方 CLI。' +
          `它常驻占用 ${String(AUTH_HELPER_QUOTA.cores)} 核 CPU、${String(AUTH_HELPER_QUOTA.ramMb)} MB 内存，` +
          '已从任务调度容量中预留。',
      };
    }

    if (s.starting) {
      return {
        status: 'info',
        headline: '登录环境准备中',
        detailText:
          '帐号登录环境正在创建，首次可能需要下载镜像。' +
          '这期间「帐号登录」会失败，API Key 不受影响。',
        nextStep: '等它拉完再点「帐号登录」；想看进度就看 api 容器的日志。',
      };
    }

    if (s.ready && s.stale === true) {
      return {
        status: 'warn',
        headline: '帐号登录环境已失效',
        detailText:
          `帐号登录环境的实例${stateText(s.instanceState)}。` +
          '只影响「帐号登录」和凭证自动刷新，API Key 不受影响，已配好凭证的任务也照常运行。',
        nextStep: REBUILD_NEXT_STEP,
        ...(s.instanceState === undefined ? {} : { detail: { instanceState: s.instanceState } }),
      };
    }

    if (s.awaitingRebuild === true) {
      // ⚠️ 不是「建不起来」：上一个实例在使用中被确认失效、作废了，还没轮到重建。⛔ 别落到
      //    下面那句「多半是镜像没拉下来」—— 那会把排障引到完全不相干的方向。
      return {
        status: 'warn',
        headline: '帐号登录环境已失效',
        detailText:
          `${s.lastError ?? '上一个帐号登录环境已失效'}。` +
          '只影响「帐号登录」和凭证自动刷新，API Key 不受影响，已配好凭证的任务也照常运行。',
        nextStep: REBUILD_NEXT_STEP,
      };
    }

    if (s.ready) {
      return {
        status: 'info',
        headline: '登录环境状态待确认',
        detailText:
          `帐号登录环境已创建，但这次没能确认它是否仍在运行${s.probeError === undefined ? '' : `（${s.probeError}）`}。` +
          '真正登录或刷新凭证时会再核对一次，确认失效就自动重建；API Key 不受影响。',
        nextStep: '稍后再跑一次诊断；一直如此的话，看 api 容器日志里运行时的报错。',
      };
    }

    return {
      status: 'warn',
      headline: '帐号登录暂不可用',
      detailText:
        `帐号登录环境没起来${s.lastError === null ? '' : `：${s.lastError}`}。` +
        '只影响「帐号登录」这一条路，API Key 不受影响，已配好凭证的任务也照常运行。',
      nextStep: '多半是预制镜像还没拉下来或这台机器拉不动；先看上面那项「预制镜像就绪」。',
      errorCode: 'PROVIDER_UNAVAILABLE',
    };
  }
}

/**
 * 「实例___」—— 把 provider 的生命周期状态说成人话。
 * ⚠️ boxlite 把 configured / stopping / failed 也报成 `instance_missing`，所以那一句不能只说「被删了」。
 */
function stateText(state: SandboxRuntimeLifecycleState | undefined): string {
  switch (state) {
    case 'instance_missing':
      return '已不存在或已失败';
    case 'instance_exited':
      return '已停止运行';
    case 'instance_dead':
      return '已崩溃';
    case 'instance_paused':
      return '已被暂停';
    case 'instance_creating':
      return '还没有启动';
    default:
      return '已不在运行';
  }
}
