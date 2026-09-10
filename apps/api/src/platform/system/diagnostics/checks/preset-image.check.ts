import { Inject, Injectable } from '@nestjs/common';
import {
  builtinImageDeclaresTmux,
  builtinImageRefFor,
  isBuiltinImageConfigured,
  isPublishedImageRef,
  publishedImageFor,
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
import {
  PresetImageProvisioner,
  type ProvisionPlanner,
} from '../../preset-image/preset-image-provisioner';

/**
 * 构建脚本目录 —— **按档，不是一个常量**。
 *
 * ⛔ 此前恒为 `api/images/platform-sandbox`（aio 那档）。而 macOS 的默认档是 boxlite，
 *    它的构建目录是 `api/images/platform-boxlite` —— 指错目录，用户 build 出来的
 *    是**另一档的镜像**，拉得到、播得下去，在建任务门口才撞 `IMAGE_PROVIDER_MISMATCH`。
 */
function buildScriptFor(tier: string): string {
  return tier === 'boxlite' ? 'api/images/platform-boxlite' : 'api/images/platform-sandbox';
}

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
    // ⚠️ **必须显式 `@Inject`**：`ProvisionPlanner` 是 interface，运行期不存在，
    //    Nest 拿不到注入 token（2026-09-05 实测：24 个 e2e 文件一起挂在
    //    「argument at index [3]」）。⇒ 类型用窄口子（测试替身写一个方法就够），
    //    token 用那个类 —— 两件事各自取所需，不必为了 DI 把类型放宽回去。
    @Inject(PresetImageProvisioner) private readonly provisioner: ProvisionPlanner,
  ) {}

  async run(): Promise<DiagnoseCheckResult> {
    // ── 第 1 步：**这台机器该用哪一张** ──────────────────────────────────────
    //
    // ⛔ 本步此前问的是「`SANDBOX_DEFAULT_IMAGE` 配了没有」，没配就判 fail。
    //    2026-09-07 起**没配才是正确的出厂状态**：平台按宿主档位在两张发布镜像里自动挑
    //    （darwin ⇒ boxlite，linux ⇒ aio）。照旧判据，一台两张预制镜像都已播种、都
    //    `valid` 的机器会被诊断告知「建任务必失败」——**实测就是这样**（2026-09-07
    //    全新部署跑通后，本项仍报 fail）。
    //
    // ⛔ 而它给的下一步更贵：「SANDBOX_DEFAULT_IMAGE=<registry>/platform/sandbox:<tag>」
    //    —— 照着填就让按机器自动选**永远失效**，另一档的宿主从此拿错镜像。
    //    **一条把人指向亲手关掉这条路的提示，比不给提示更贵。**
    //
    // ⇒ 现在问的是「这一档有没有一张可用的坐标」：配了就用配的，没配就用这一档的发布
    //   镜像。真正的「没有」只剩一种 —— **第三方 provider 当默认档，而它不在发布表里**，
    //   那时平台确实不知道该用哪张，猜一个比响亮失败更糟（04 §8）。
    const tier = this.providers.defaultProvider;
    const ref = builtinImageRefFor(tier);
    if (ref === '' || (!isBuiltinImageConfigured() && publishedImageFor(tier) === undefined)) {
      return {
        status: 'fail',
        step: 'config',
        errorCode: PRESET_IMAGE_NOT_CONFIGURED,
        summary:
          `默认档位是 '${tier}'，而平台既没有为它发布预制镜像，也没有配置 ` +
          'SANDBOX_DEFAULT_IMAGE —— 平台不知道该用哪张镜像，建任务必失败',
        hint:
          `为这一档指定镜像：SANDBOX_${tier.toUpperCase()}_IMAGE=<registry>/<repo>:<tag>` +
          `（按档配，不会影响其它档；构建脚本在 ${buildScriptFor(tier)}），改完重启平台，开机会自动播种`,
        detail: { tier, fallbackRef: ref, configured: false },
      };
    }

    // ── 第 2 步：**平台目录里就绪了吗**（本地读，不触网）────────────────────
    //
    // ⛔ 此前这一步直接去 registry 解析。出厂默认还是本地 registry 时那是亚秒级的；
    //    2026-09-07 换成 ghcr.io 上的发布镜像之后，它变成 **4 次跨洋往返、实测 10.87s**，
    //    而诊断给每一项的预算是 `DIAGNOSE_TIMEOUT_MS = 5s` ⇒ **本项从此永远只有一个
    //    「5 秒内没有结果」**，连一台完全健康的机器也是。实测就是这样。
    //
    // ⚠️ 而那次往返**问不出新东西**：这一项要回答的是「现在能不能建出 Task」，
    //    那是平台自己目录里的事实 —— 而目录里的每一行都是**在注册期走过 registry 解析
    //    与血统准入之后**才写下的（`registerImage` 的准入门）。目录里有它，
    //    就意味着那两关当时都过了。⇒ 目录能回答的，别再去问网络。
    //
    // ⇒ 只有**目录里没有**时才去问 registry —— 那时我们确实需要它说出「为什么没有」
    //   （拉不到？血统不认？还是播种没跑完？），而那也正是值得等的时候。
    const catalogued = await this.images.findRegisteredByRef(ref);
    if (catalogued !== null) {
      return this.notSeededVerdict(ref, catalogued) ?? this.stagedVerdict(ref, catalogued);
    }

    // ── 第 3 步：registry 里存不存在 ────────────────────────────────────────
    let resolved: ResolvedImage;
    try {
      resolved = await this.specs.get(this.specs.defaultProvider).resolve(ref);
    } catch (e) {
      const reason = (e as Error).message;
      // ⛔ **先问「字节够不够得着」，够得着就别让用户去敲命令**（P21-8 §2 ⇒ 新判据）。
      //    2026-09-05 实测：清空 registry 后镜像的字节仍躺在本机 docker 库里，而这里
      //    原样输出的 hint 是「docker build ... && docker push ...」—— 让用户**重新
      //    build 一遍已经有的东西**。平台明明能做而让用户去敲命令，那不是指路，
      //    是把自己的活派给用户。
      const plan = await this.provisioner.plan();
      return {
        status: 'fail',
        step: 'registry',
        errorCode: PRESET_IMAGE_NOT_IN_REGISTRY,
        summary: `镜像 '${ref}' 在 registry 里解析不到：${reason}`,
        hint: plan.provisionable
          ? `${plan.why}。⇒ 在初始化向导或系统状态页点 [准备镜像]，平台会自己把它搬到位（${plan.from} → ${plan.to}${plan.sizeBytes === null ? '' : `，约 ${String(Math.round(plan.sizeBytes / 1024 / 1024))} MB`}）`
          : // ⛔ **出厂发布镜像不能让用户去 build+push** —— 那是平台自己的 registry，
            //    他推不上去；而且这句话会把他引向「改 SANDBOX_DEFAULT_IMAGE」，
            //    那正好关掉按机器自动选。这一档的根因是**够不到 registry**。
            isPublishedImageRef(ref)
            ? `${plan.why}。⇒ 这是平台**按你这台机器自动选**的出厂镜像，不用你构建：` +
              `先确认这台机器够得到它的 registry（试 \`curl -sSf https://${registryHostOf(ref)}/v2/\`），` +
              '企业网关 / 离线内网会拦掉它。离线部署请把镜像镜到内网 registry，' +
              `再用**按档覆盖** SANDBOX_${tier.toUpperCase()}_IMAGE 指过去 —— 按档配才不会让另一档拿错`
            : `${plan.why}。⇒ 用平台的构建脚本构建再推：docker build -t ${ref} ${buildScriptFor(tier)} && docker push ${ref}。` +
              '内网 registry 需要凭证或走代理时，先在系统设置里配好代理再重新诊断',
        detail: { ref, reason, provision: plan },
      };
    }

    // ── 第 4 步：它是不是平台认可的那一张 ───────────────────────────────────
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
          `用平台的构建脚本重新构建再推：docker build -t <registry>/platform/sandbox:<tag> ${buildScriptFor(tier)} ` +
          '&& docker push <registry>/platform/sandbox:<tag>，然后把 SANDBOX_DEFAULT_IMAGE 指过去并重启平台；' +
          '若这张镜像确实装了 tmux（自建 / 内网 mirror / 改过名），设置 SANDBOX_DEFAULT_IMAGE_TMUX=true 并重启',
        detail: { ref, digest: resolved.digest, declaredTmux: false },
      };
    }

    // ── 第 5 步：镜像在、血统也认，却不在目录里 ⇒ 开机播种没跑成 ─────────────
    //
    // ⚠️ 走到这里 `catalogued` 必然是 null（有它就在上面返回了），所以这里问的**只剩
    //    一件事**：字节都对，为什么平台没记下来。`notSeededVerdict(ref, null)` 说的
    //    正是这件事，且它永远返回非 null。
    return this.notSeededVerdict(ref, null) ?? this.stagedVerdict(ref, catalogued!);
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
    // ⚠️ **未 staged 那一格要带 provision 计划**，所以这里先问一次「平台自己搬得了吗」。
    const plan = await this.provisioner.plan();
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
          // ⛔ **「已在本机铺开」必须自带那半句「不依赖 registry 此刻在不在」**
          //    （2026-09-05 修）。此前它只说「已铺开，可以立即发起任务」，而同一屏上
          //    第 ⑤ 项可能正报 `localhost:5001` ❌（registry 现在没起）。两个结论**都对**
          //    ——字节早就在本机了，registry 只在**拉取时**需要——但界面没说它们问的是
          //    两件事，用户只会读成「诊断自相矛盾」，进而两条都不信。
          //    ⇒ 结论不变，把它成立的**前提**说出来。
          summary:
            `预制镜像就绪：'${ref}' 已注册、已在本机铺开，可以立即发起任务` +
            ' —— 字节在本机，此刻不需要 registry（第 ⑤ 项若报镜像仓库不可达，只影响**拉新镜像**）',
          detail: { ...detail, staged: true, dependsOnRegistryNow: false },
        };
      }
      return {
        // ⛔ 这里**必须**是 info。它不是一个待修的问题：镜像是对的，只是这台机器还没
        //    把 rootfs 铺开。渲染成 ⚠️ 会让用户去修一个不需要修的东西。
        status: 'info',
        step: 'staged',
        // ⛔ **代价按档说，别拿另一档的数字吓人**（2026-09-07 实测）。这句话曾恒为
        //    「13GB 镜像实测冷启动约 190 秒」—— 那是 aio 档的数字。而 macOS 的默认档是
        //    boxlite，它的镜像**压缩后 0.31GB**（实测），差了一个数量级还多。
        //    ⚠️ 一个大 40 倍的估计不是「保守」：它让人以为要去泡杯咖啡，或者反过来，
        //    在真该等的那一档上以为几秒就好。`provision-plan.ts` 早就记着两档的真实
        //    量级差（「boxlite 档 431MB vs 本地 build 产物 13GB」），这里照着说。
        summary: `预制镜像已就绪，但尚未在本机铺开（${firstRunCost(provider.name)}）`,
        hint: stageHint(provider.name, ref, plan.provisionable),
        // ⚠️ 与上面那格相反：还没铺开 ⇒ 首个任务真的要去 registry 拉。
        // ⚠️ **`provision` 必须带上**：前端据它给出 [准备镜像] 按钮（`provisionOfferOf`）。
        //    此前这一格恒不带 ⇒ 向导只能指路，铺开被后置到第一个任务 —— 而那正是
        //    用户明确否掉的形态（2026-09-10）。
        detail: { ...detail, staged: false, dependsOnRegistryNow: true, provision: plan },
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

/** 从镜像 ref 里取 registry host（`host[:port]/repo:tag` 的第一段），判据照抄 docker。 */
function registryHostOf(ref: string): string {
  const [first = ''] = ref.split('/');
  if (first === ref) return 'docker.io';
  if (!(first.includes('.') || first.includes(':') || first === 'localhost')) return 'docker.io';
  const colon = first.lastIndexOf(':');
  return colon > 0 ? first.slice(0, colon) : first;
}

/**
 * 首个任务铺开镜像的**量级** —— 按档，实测值。
 *
 * ⚠️ 说的是「量级」不是精确秒数：它取决于带宽与磁盘。给一个数量级正确的预期，
 * 好过给一个精确但属于另一档的数字。
 */
/**
 * 「想提前铺开怎么办」——**必须按档分岔**（2026-09-09 真机发现）。
 *
 * ⛔ 上一版恒为 `docker pull <ref>`。而 macOS 上的默认档是 **boxlite，那台机器上通常
 * 根本没有 docker**（boxlite 官方卖点就是 "no root, no background service"）——一条
 * 执行不了的命令，还会让人以为平台依赖 docker。
 *
 * ⚠️ 这正是本仓已经踩过并写进 `connectivity.probe.ts#hintFor` 的那个坑的另一半：
 * 那次的教训原话是「躲过了『支去配代理』，却掉进了同一个坑的另一半：**支去装 docker**」。
 * 同一份纪律，这里漏了一处。
 *
 * ⚠️ **boxlite 档没有「手动提前拉」这条路，就要如实说没有**，别编一个。平台运行期
 * 独占 `~/.boxlite`，此时跑 boxlite CLI 会直接拿不到锁（实测原文：
 * `Another BoxliteRuntime is already using directory`）。⇒ 那一档的正确答案是
 * 「什么都不用做，也别去手动拉」，而不是换一条命令继续指使用户。
 */
function stageHint(tier: string, ref: string, canProvisionNow: boolean): string {
  // ⛔ **平台自己能做的时候，一个字都不要教用户去做**（`provision-plan.ts` 文件头那条：
  //    平台明明能做而让用户去敲命令，那不是指路，是把自己的活派给用户）。
  //
  // ⚠️ 这一格此前恒为「不需要做任何事，第一个任务会自动铺开」—— 读起来像体贴，实际是
  //    **把等待挪到了最差的时机**：用户写完指令、点了发起，然后对着一个静默进度条等
  //    十几到二十分钟（实测这台机器到 ghcr 273 KB/s，boxlite 那张压缩后 320MB ⇒ 约 20 分钟）。
  //    而且那时它跑在 provision workflow 里，失败就是一个失败的 Task，不是一个可以
  //    重试的向导步。⇒ 能自己铺就在向导里铺（用户 2026-09-10 明确要求）。
  if (canProvisionNow) {
    return (
      '**现在就可以铺**：点 [准备镜像]，平台自己去拉一次（不必等第一个任务 —— ' +
      '那时你已经写完指令，等待落在最差的时机）。⚠️ 这一步**要 registry 在**' +
      '——第 ⑤ 项若报镜像仓库不可达，先解决那个'
    );
  }
  if (tier === 'boxlite') {
    return (
      '不需要做任何事：第一个任务会自动把镜像铺开（耗时见上一行）。' +
      '⛔ **别用 boxlite CLI 手动提前拉** —— 平台运行期独占 `~/.boxlite`，' +
      'CLI 会拿不到锁（实测报「Another BoxliteRuntime is already using directory」）。' +
      '想提前铺开就直接建一个任务，那一次多花的时间就是上面那个数。' +
      // ⚠️ 这半句两档都要有（2026-09-05 那条纪律）：铺开这件事本身**要 registry 在**，
      //    换成 boxlite 档也一样 —— 它同样是去 ghcr 拉。⛔ 别因为改了前半句就把它丢掉。
      '⚠️ 这一步**要 registry 在**——第 ⑤ 项若报镜像仓库不可达，先解决那个'
    );
  }
  return (
    `不需要做任何事，等第一个任务跑完即可；想提前铺开可以先手动拉一次：docker pull ${ref}` +
    '。⚠️ 这一步**要 registry 在**——第 ⑤ 项若报镜像仓库不可达，先解决那个'
  );
}

function firstRunCost(tier: string): string {
  return tier === 'boxlite'
    ? 'boxlite 档镜像压缩后约 0.3GB，通常十几秒到一分钟'
    : 'aio 档镜像 13GB，实测冷启动约 190 秒';
}
