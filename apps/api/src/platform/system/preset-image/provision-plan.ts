import { parseImageRef } from '@platform/contracts';

/**
 * 「这张预制镜像的**字节够不够得着**」—— 搬运计划的纯判定部分。
 *
 * ── 它修的是什么：一条把平台自己的活派给用户的路 ──────────────────────────────
 * 2026-09-05 重置实测：清空 registry 后，预制镜像的字节**仍然躺在本机 docker 镜像库里**
 * （13GB），只是不在 registry。此时平台做的是报一个 ❌，让用户去敲两条命令 —— 其中一条
 * 还是让他 **重新 build 一遍已经有的东西**。
 *
 * ⛔ **「给命令」不是「指路」的同义词。** 指路的前提是平台确实无能为力；平台明明能做而让
 * 用户去敲命令，那不是指路，是把自己的活派给用户（P21-8 §2 ⇒ 新判据）。
 *
 * ── 判据：先问字节在哪，再决定搬还是指路 ────────────────────────────────────
 * | 情形 | 字节在哪 | 结论 |
 * |---|---|---|
 * | `local-docker`  | 本机 docker 镜像库有，registry 没有 | 自己 push（回环，不出网） |
 * | `release-asset` | 发布资产清单列了它               | 自己校验 + 装载 + push |
 * | `upstream-copy` | 只有上游 registry 有             | 纯 HTTP 搬（不碰 docker） |
 * | `build-only`    | 哪儿都没有，只有 Dockerfile      | **才轮到指路** |
 *
 * ⚠️ **顺序不是偏好，是代价排序**：`local-docker` 不出网；`release-asset` 出网但有 sha256
 * 兜底且体积小一个数量级（boxlite 档 431MB vs 本地 build 产物 13GB）。先问便宜的那个。
 *
 * ⚠️ **`upstream-copy` 补上了那一格**（2026-09-05）。它独占的场景是「没有 docker **且**
 * 没有资产清单 **且** 上游可达」—— 而那不是边角：**boxlite 档的宿主上可以根本没有 docker**
 * （P21-5 §9F）。此前这种机器会被判成 `build-only`「搬不了」，而它其实只需要在两个 HTTP
 * 端点之间搬一次字节。实现见 `registry-copy.ts`（纯 HTTP，不碰 docker）。
 *
 * ⚠️ **它排在最后不是因为最差，是因为最贵**：另外两条要么不出网、要么本机已有字节。
 */

/** 搬运源。`build-only` 是「搬不了」的那一格，留在同一个联合里是为了让 `plan()` 总有话说。 */
export type ProvisionSource = 'local-docker' | 'release-asset' | 'upstream-copy' | 'build-only';

/** 发布资产清单里的一条（`cap-image-assets.json`，`schemaVersion: 1`）。 */
export interface ReleaseAsset {
  readonly id: string;
  readonly provider: string;
  readonly platform: string;
  readonly kind: 'docker-archive' | 'oci-layout';
  readonly image: string;
  readonly asset: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ProvisionPlan {
  readonly source: ProvisionSource;
  /** 能不能由平台自己搬到位。`build-only` ⇒ false。 */
  readonly provisionable: boolean;
  /** 搬多少字节 —— 按之前就要告诉用户代价（P21-8 §2）。未知返 null，**不猜**。 */
  readonly sizeBytes: number | null;
  /** 从哪搬到哪，原样说出来，用户才对得上。 */
  readonly from: string;
  readonly to: string;
  /** 一句人话：为什么是这个结论。`build-only` 时它就是「指路」那句话的由来。 */
  readonly why: string;
  /** `release-asset` 时命中的那条资产；其余为 null。 */
  readonly asset: ReleaseAsset | null;
}

/** `plan()` 需要的**全部**外部事实 —— 收窄到这三个读，替身就不必扮演一整个 docker。 */
export interface ProvisionFacts {
  /** 目标坐标（`SANDBOX_DEFAULT_IMAGE`）。 */
  readonly ref: string;
  /** 本机 docker 镜像库里有没有这个 tag。docker 不在 ⇒ false（不是 null：没有 docker 就是没有这张）。 */
  readonly inLocalDocker: boolean;
  /** 资产清单里按 provider × platform 命中的那条；没命中 / 没配清单 ⇒ null。 */
  readonly asset: ReleaseAsset | null;
  /**
   * 上游坐标（`SANDBOX_PRESET_IMAGE_SOURCE`）。配了才有这条路 —— ⛔ **不猜一个上游**：
   * 猜错会去拉一张不是平台自建的镜像，搬完了照样过不了血统检查（04 §7 ★），
   * 而那时几百 MB 已经白搬了。
   */
  readonly upstream: string | null;
}

/**
 * 定计划。
 *
 * ⚠️ **纯函数**：不碰网络、不碰文件系统。三个事实由调用方查好传进来 —— 于是这张判据表
 * 可以被逐格钉住，而不必为了测一句判断去起一个 docker。
 */
export function planProvision(f: ProvisionFacts): ProvisionPlan {
  if (f.inLocalDocker) {
    return {
      source: 'local-docker',
      provisionable: true,
      // ⚠️ 体积这里给不出：dockerode 的 image inspect 能拿到 Size，但那是**解压后**的
      //    尺寸，而 push 传的是压缩层。给一个大一号的数会让进度条一直"差得远"。
      //    ⇒ 如实 null，由 push 的进度事件把真实字节数报出来（少报是降级）。
      sizeBytes: null,
      from: '本机 docker 镜像库',
      to: registryAuthorityOf(f.ref),
      why: `'${f.ref}' 的字节已经在本机 docker 镜像库里，只是没推到 registry —— 平台自己推上去即可，不出网、不重建`,
      asset: null,
    };
  }

  if (f.asset !== null) {
    return {
      source: 'release-asset',
      provisionable: true,
      sizeBytes: f.asset.sizeBytes,
      from: `发布资产 ${f.asset.asset}`,
      to: registryAuthorityOf(f.ref),
      why:
        `发布资产清单里有匹配这台机器的那一份（${f.asset.provider} · ${f.asset.platform} · ${f.asset.kind}）—— ` +
        '平台校验 sha256 后自己装载并推上去',
      asset: f.asset,
    };
  }

  if (f.upstream !== null && f.upstream.trim() !== '') {
    return {
      source: 'upstream-copy',
      provisionable: true,
      // ⚠️ 体积要等读到 manifest 才知道（层的 size 在里面）。定计划时如实 null，
      //    由拷贝的进度事件按「第 n / 共 m 层」报 —— ⛔ 不编一个数。
      sizeBytes: null,
      from: f.upstream,
      to: registryAuthorityOf(f.ref),
      why:
        `本机 docker 镜像库与发布资产清单都没有，但配了上游坐标 '${f.upstream}' —— ` +
        '平台纯 HTTP 把它搬过来（不碰 docker，boxlite 档的宿主本来就可以没有 docker）',
      asset: null,
    };
  }

  return {
    source: 'build-only',
    provisionable: false,
    sizeBytes: null,
    from: '（无）',
    to: registryAuthorityOf(f.ref),
    why:
      `'${f.ref}' 的字节在这台机器上够不着：本机 docker 镜像库里没有、发布资产清单没有匹配这台机器的那一份、也没有配上游坐标（SANDBOX_PRESET_IMAGE_SOURCE）。` +
      '⇒ 这一格确实只能构建，平台代劳不了',
    asset: null,
  };
}

/**
 * 坐标 → registry 权威部分，只为把「搬到哪」说清楚。
 *
 * ⚠️ 判据与 `registryTargetOf`（`connectivity.probe.ts`）**同源同一条**：第一段有 `.` 或 `:`
 * 或就是 `localhost` 才是权威部分，否则是 Docker Hub 短名。两处若各写一套，
 * 迟早出现「诊断说搬到 A、实际推到 B」。
 */
export function registryAuthorityOf(ref: string): string {
  // ⛔ **必须先 `parseImageRef` 剥掉 tag/digest，再切第一段。** 直接切原串会把 `alpine:3.20`
  //    的**标签冒号**读成端口冒号，于是一个 Docker Hub 短名被当成主机名 `alpine:3.20`
  //    ——正是 `registryTargetOf` 顶部两条 ⚠️ 记着的那类错误（「把坐标的一段当成了它不是的
  //    东西」）。写这个函数时我漏了这一步，被 `alpine:3.20 ⇒ docker.io` 那条用例当场逮住。
  const { name } = parseImageRef(ref.trim());
  const first = name.split('/')[0] ?? '';
  const isAuthority = first.includes('.') || first.includes(':') || first === 'localhost';
  return isAuthority ? first : 'docker.io';
}

/**
 * 从资产清单里挑出**这台机器该用的那一条**。
 *
 * ⚠️ **provider 与 platform 都要对上，缺一不可。** 两档的镜像不可互换（boxlite 那张里没有
 * :8080 的 agent，11 §1.3），架构不对则根本跑不起来 —— 挑错了会在 push 完成之后才炸，
 * 而那时字节已经白搬了。
 */
export function pickAsset(
  assets: readonly ReleaseAsset[],
  provider: string,
  platform: string,
): ReleaseAsset | null {
  return assets.find((a) => a.provider === provider && a.platform === platform) ?? null;
}
