import { Inject, Injectable } from '@nestjs/common';
import {
  builtinImageDeclaresTmux,
  builtinImageRef,
  isBuiltinImageConfigured,
} from '@platform/shared-kernel';
import {
  IMAGE_FACADE,
  IMAGE_SPEC_REGISTRY,
  PRESET_IMAGE_NOT_CONFIGURED,
  PRESET_IMAGE_NOT_IN_REGISTRY,
  PRESET_IMAGE_NOT_PLATFORM_BUILT,
  PRESET_IMAGE_NOT_SEEDED,
  SANDBOX_PROVIDER_REGISTRY,
} from '@platform/contracts';
import type {
  ImageFacade,
  ImageSpecRegistry,
  ProviderRegistry,
  RegisteredImageSummary,
  ResolvedImage,
} from '@platform/contracts';
import type { DiagnoseCheck, DiagnoseCheckResult } from './check.types';

/** 平台预制镜像的构建脚本位置 —— 每一步的建议都要指向它，所以只写一次。 */
const BUILD_SCRIPT = 'api/images/platform-sandbox';

/**
 * 诊断第 ⑧ 项：**预制镜像就绪**（P21-5 §9A，2026-08-28 实测补）。
 *
 * ── 它修的是什么：七项全绿，一个 Task 都建不出来 ────────────────────────────
 * 真实形态：容器运行时在、`/dev/kvm` 可用、磁盘 200G+、端口没被占、外网通、WS 回环
 * 正常、`DATA_ROOT` 文件系统正确 —— **前七项全绿**，而用户点「发起任务」得到的是
 * 「平台还没有可用的预制镜像」。
 *
 * ⚠️ **前七项问的是「这台机器能不能跑东西」，没有一项问「平台自己备齐了没有」。**
 * 而后者才是「能不能建出第一个 Task」的决定条件。
 *
 * ⚠️ **更糟的是报错出现的时机**：它出现在**新建任务弹窗里** —— 用户已经建好项目、
 * 选完运行时、填好指令、点了按钮，才被告知平台根本没准备好。这是整条链路上最晚、
 * 也最挫败的时机。这一项（以及 P21-8 §2 Step 3 的向导版本）把那堵墙提前指出来。
 *
 * ── 五步链，任一失败即止 ────────────────────────────────────────────────────
 * ⛔ **五步的失败不许合成一条「镜像不可用」** —— 它们的下一步动作完全不同：
 * 改配置 / 推镜像 / 换成自建的那张 / 重启平台 / 只是等一会。合成一条等于把诊断退化成
 * 一个红灯。落地上这条纪律有三个抓手：每步一个 `step`、前四步各一个 `errorCode`
 * （闭集在 `sse-protocol.ts`）、以及**各不相同的 `hint`**。
 *
 * ⚠️ **第 5 步「未 staged」不是失败，是 ℹ️。** 它告知「首个任务需要数分钟准备镜像」
 * （实测 13GB 镜像冷启动 190 秒）。渲染成 ⚠️ 会让用户去修一个不需要修的东西 ——
 * 而他能想到的「修法」是删了重推，那会让情况更糟。
 */
@Injectable()
export class PresetImageCheck implements DiagnoseCheck {
  readonly id = 'preset-image' as const;
  readonly label = '预制镜像就绪';

  constructor(
    @Inject(IMAGE_SPEC_REGISTRY) private readonly specs: ImageSpecRegistry,
    @Inject(IMAGE_FACADE) private readonly images: ImageFacade,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
  ) {}

  async run(): Promise<DiagnoseCheckResult> {
    // ── 第 1 步：配了没有 ────────────────────────────────────────────────────
    const ref = builtinImageRef();
    if (!isBuiltinImageConfigured()) {
      return {
        status: 'fail',
        step: 'config',
        errorCode: PRESET_IMAGE_NOT_CONFIGURED,
        // ⚠️ 要说清兜底那张**为什么必炸**，否则「没配也有个默认值」听起来像可以先不管。
        summary:
          `SANDBOX_DEFAULT_IMAGE 没有配置，平台回落到内置兜底坐标 '${ref}' —— ` +
          '那是上游镜像，没有平台的沙箱 API、没有 tmux、没有常驻进程，容器一退端口就空，建任务必失败',
        hint:
          `在平台的环境变量里指向自建预制镜像：SANDBOX_DEFAULT_IMAGE=<registry>/platform/sandbox:<tag>` +
          `（构建脚本在 ${BUILD_SCRIPT}），改完重启平台，开机会自动播种`,
        detail: { fallbackRef: ref, configured: false },
      };
    }

    // ── 第 2 步：registry 里存不存在 ────────────────────────────────────────
    let resolved: ResolvedImage;
    try {
      resolved = await this.specs.get(this.specs.defaultProvider).resolve(ref);
    } catch (e) {
      const reason = (e as Error).message;
      return {
        status: 'fail',
        step: 'registry',
        errorCode: PRESET_IMAGE_NOT_IN_REGISTRY,
        summary: `镜像 '${ref}' 在 registry 里解析不到：${reason}`,
        hint:
          `确认镜像已推上去：docker pull ${ref}；没有就先构建再推 —— ` +
          `docker build -t ${ref} ${BUILD_SCRIPT} && docker push ${ref}。` +
          '内网 registry 需要凭证或走代理时，先在系统设置里配好代理再重新诊断',
        detail: { ref, reason },
      };
    }

    // ── 第 3 步：它是不是平台认可的那一张 ───────────────────────────────────
    //
    // ⚠️ 判据与**注册期对根镜像的判据是同一条**（`assertRootDeclaresTmux`，04 §7 ★血统 ③）：
    //    根镜像豁免血统比对（它就是锚点），取而代之的是「运维方声明过这张镜像有 tmux 吗」。
    //    这里必须复用同一个函数，否则会出现「诊断说就绪、注册仍被拒」这种两边各自正确、
    //    合起来撒谎的组合 —— 本仓反复付过学费的那种形态。
    //
    // ⚠️ 2026-08：声明的来源从镜像标签换成了平台配置（`builtinImageDeclaresTmux()`），
    //    因为 `platform.tmux` 标签逼着平台维护一层只为盖章、零字节新层的中间镜像。
    //    问的还是同一件事，只是不再要求运维方先成为镜像作者。
    if (!builtinImageDeclaresTmux(ref)) {
      return {
        status: 'fail',
        step: 'lineage',
        errorCode: PRESET_IMAGE_NOT_PLATFORM_BUILT,
        // ⚠️ 必须说清「注册也会被拒」。不说的话用户会以为只是少做了一步注册，
        //    照着去 POST /api/images 再撞一次墙 —— 而那次撞墙看起来像是他做错了。
        summary:
          `'${ref}' 平台不认识，也没有人声明过它装了 tmux。` +
          'agent 会话由沙箱内的 tmux 持有，根镜像又是所有自定义镜像的血统起点，' +
          '**手动注册同样会被准入检查拒**，不是少做了一步注册',
        hint:
          `用平台的构建脚本重新构建再推：docker build -t <registry>/platform/sandbox:<tag> ${BUILD_SCRIPT} ` +
          '&& docker push <registry>/platform/sandbox:<tag>，然后把 SANDBOX_DEFAULT_IMAGE 指过去并重启平台；' +
          '若这张镜像确实装了 tmux（自建 / 内网 mirror / 改过名），设置 SANDBOX_DEFAULT_IMAGE_TMUX=true 并重启',
        detail: { ref, digest: resolved.digest, declaredTmux: false },
      };
    }

    // ── 第 4 步：注册进平台且 validationStatus = valid ──────────────────────
    const registered = await this.images.findRegisteredByRef(ref);
    const notSeeded = this.notSeededVerdict(ref, registered);
    if (notSeeded !== null) return notSeeded;

    // ── 第 5 步：本机 staged 没有（**不是失败**） ────────────────────────────
    return this.stagedVerdict(ref, registered!);
  }

  /** 第 4 步的三种「没就绪」—— 它们的下一步各不相同，所以文案也各不相同。 */
  private notSeededVerdict(
    ref: string,
    registered: RegisteredImageSummary | null,
  ): DiagnoseCheckResult | null {
    const common = { step: 'registration' as const, errorCode: PRESET_IMAGE_NOT_SEEDED };
    if (registered === null) {
      return {
        ...common,
        status: 'fail',
        summary: `'${ref}' 是对的那张镜像，但平台里没有它的注册记录 —— 开机播种没有成功`,
        hint:
          '重启平台让它重新播种；仍然失败就看开机日志里 ImageSeeder 的那一行 —— ' +
          '离线部署 / registry 限流会让播种在 10s 预算内放弃（平台仍会正常启动，只是建不了 Task）',
        detail: { ref, registered: false },
      };
    }
    if (registered.validationStatus === 'invalid') {
      return {
        ...common,
        status: 'fail',
        summary: `'${ref}' 已注册，但校验结论是 invalid，不能被任何任务引用（I-IMG-2）`,
        hint: `在镜像管理里重新校验（POST /api/images/${registered.manifestId}/validate）看逐条结论；多半要换一张构建正确的镜像`,
        detail: { ref, ...summaryDetail(registered) },
      };
    }
    if (!registered.isActive) {
      return {
        ...common,
        status: 'fail',
        summary: `'${ref}' 已注册但该版本已停用，不能被新任务选用（I-IMG-3）`,
        hint: `在镜像管理里启用它：POST /api/images/${registered.manifestId}/activate`,
        detail: { ref, ...summaryDetail(registered) },
      };
    }
    return null;
  }

  /**
   * 第 5 步。**未 staged 是 ℹ️，不是 ⚠️**。
   *
   * ⚠️ `imageStaged` 是可选方法（04 §11「minor = 新增可选方法」）。provider 没实现它时
   * 唯一诚实的答案是「不知道」—— 不是 `false`。契约原文：一个错的 `false` 承诺一次
   * 多分钟的等待然后 4 秒就好了（无伤大雅），一个错的 `true` 把用户丢回一个静默的
   * 190 秒转圈，而平台刚告诉过他会很快。所以「不知道」就照实说不知道。
   */
  private async stagedVerdict(
    ref: string,
    registered: RegisteredImageSummary,
  ): Promise<DiagnoseCheckResult> {
    const provider = this.providers.get(this.providers.defaultProvider);
    const detail = { ref, ...summaryDetail(registered), provider: provider.name };
    if (typeof provider.imageStaged !== 'function') {
      return {
        status: 'ok',
        step: 'staged',
        summary: `预制镜像就绪：'${ref}' 已注册且可选用（${registered.validationStatus}）。当前 provider（${provider.name}）不报告镜像是否已在本机铺开`,
        detail: { ...detail, staged: null },
      };
    }
    try {
      const staged = await provider.imageStaged({
        ref: registered.ref,
        digest: registered.digest,
        ...(registered.entrypoint ? { entrypoint: registered.entrypoint } : {}),
      });
      if (staged) {
        return {
          status: 'ok',
          step: 'staged',
          summary: `预制镜像就绪：'${ref}' 已注册、已在本机铺开，可以立即发起任务`,
          detail: { ...detail, staged: true },
        };
      }
      return {
        // ⛔ 这里**必须**是 info。它不是一个待修的问题：镜像是对的，只是这台机器还没
        //    把 rootfs 铺开。渲染成 ⚠️ 会让用户去修一个不需要修的东西。
        status: 'info',
        step: 'staged',
        summary: `预制镜像已就绪，但尚未在本机铺开 —— **首个任务需要数分钟准备镜像**（13GB 镜像实测冷启动约 190 秒），之后每次 3–4 秒`,
        hint:
          '不需要做任何事，等第一个任务跑完即可；想提前铺开可以先手动拉一次：docker pull ' + ref,
        detail: { ...detail, staged: false },
      };
    } catch (e) {
      // provider 实现了这个方法但**这一次答不上来**（store 读不了 / 运行时不可用）：
      // 契约要求它 reject 而不是猜。诊断照实转达「问不出来」，不替它猜。
      return {
        status: 'ok',
        step: 'staged',
        summary:
          `预制镜像就绪：'${ref}' 已注册且可选用。` +
          `本机是否已铺开这次问不出来（${(e as Error).message}）—— 首个任务可能需要数分钟`,
        detail: { ...detail, staged: null, reason: (e as Error).message },
      };
    }
  }
}

/** detail 里关于那一行注册记录的固定几项 —— 排障时最先要看的就是 digest。 */
function summaryDetail(r: RegisteredImageSummary): Record<string, unknown> {
  return {
    manifestId: r.manifestId,
    registeredRef: r.ref,
    digest: r.digest,
    validationStatus: r.validationStatus,
    isActive: r.isActive,
    isBuiltin: r.isBuiltin,
  };
}
