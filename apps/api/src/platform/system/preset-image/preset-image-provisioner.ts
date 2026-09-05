import { Injectable, Logger } from '@nestjs/common';
import { builtinImageRef } from '@platform/shared-kernel';
import { pickAsset, planProvision, type ProvisionPlan, type ReleaseAsset } from './provision-plan';
import { assetPresent, readAssetManifest, verifyAsset } from './release-assets';
import { streamed } from './callback-stream';

/**
 * 预制镜像的**搬运**（不是构建）。
 *
 * ── 它修的是什么 ────────────────────────────────────────────────────────────
 * 见 `provision-plan.ts` 顶部：平台明明够得着那些字节，却让用户去敲
 * `docker build && docker push`。本类是「够得着就自己搬」的执行者（P21-8 §2 ⇒ 新判据）。
 *
 * ── 阶段划分 ────────────────────────────────────────────────────────────────
 * `plan` → `fetch` → `verify` → `load` → `register`，逐阶段发 SSE。
 *
 * ⚠️ **阶段不是装饰，是「失败在哪一步」的唯一载体。** 「搬运失败」四个字对用户没有用：
 * 校验失败要换一份资产、装载失败要看磁盘、推送失败要看 registry 凭证 —— 三件不同的事。
 * ⛔ 五个阶段的失败**不许合成一条**，与五步链同一条纪律（P21-5 §9A）。
 */

/** 搬运阶段。顺序即发生顺序，前端按它画进度。 */
export const PROVISION_STAGES = ['plan', 'fetch', 'verify', 'load', 'register'] as const;
export type ProvisionStage = (typeof PROVISION_STAGES)[number];

export interface ProvisionEvent {
  readonly stage: ProvisionStage;
  readonly status: 'running' | 'ok' | 'failed' | 'skipped';
  readonly message: string;
  /** 0–1；给不出就 null —— ⛔ 不许编（见 `provision-plan.ts` 对 sizeBytes 的同一条）。 */
  readonly progress: number | null;
}

/**
 * 搬运要用到的 docker 能力 —— **收窄到三个动作**。
 *
 * ⚠️ 声明成这个而不是 dockerode 的 `Docker`，是 `ConnectivityProbe.ProxySource` 那条理由的
 * 复用：替身写三个方法就够，不必为了满足一个几十个方法的类去打 `as unknown as` 双重断言
 * —— 而那个断言一旦打下去，**将来这个类改了签名，替身也不会红**。
 *
 * ⚠️ **docker 不在是合法状态，不是错误**：boxlite 档不需要 docker（P21-5 §9F）。
 * 此时 `available()` 返 false，`plan()` 自然走不到 `local-docker` 那一格。
 */
export interface PresetImageDockerPort {
  available(): Promise<boolean>;
  hasImage(ref: string): Promise<boolean>;
  push(ref: string, onProgress: (p: number | null, msg: string) => void): Promise<void>;
  loadArchive(path: string, onProgress: (p: number | null, msg: string) => void): Promise<void>;
  tag(from: string, to: string): Promise<void>;
}

/** 搬运源目录（`SANDBOX_IMAGE_ASSETS_DIR`）。留空 ⇒ 没有资产这条路。 */
export interface AssetsDirSource {
  assetsDir(): string | undefined;
}

/**
 * 「把镜像注册进平台」这一步。
 *
 * ── 它修的是什么：一个把问题往下挪一格的假修复 ──────────────────────────────
 * 2026-09-05 实跑逮到的：搬运把 3.56GB 推进 registry 之后，诊断链从第 2 步前进到
 * **第 4 步「平台里没有它的注册记录」** —— 因为 `ImageSeeder` 只在 `onApplicationBootstrap`
 * 跑，而开机那一刻镜像还不在。
 *
 * ⛔ **那不是修好了，那是把「你自己动手」从第 2 步挪到了第 4 步**（下一步从「敲两条
 * docker 命令」变成「重启平台」）。而且 `register` 这个阶段名当时在撒谎：它只 push、不注册。
 *
 * ⇒ 推完之后就地再播一次种。`ImageSeeder.onApplicationBootstrap` 自带 `alreadySeeded`
 * 短路，重复调用是幂等的。
 */
export interface ImageSeedPort {
  seed(): Promise<void>;
}

/** 这台机器的档位与架构 —— 挑资产要它们两个都对上。 */
export interface HostFacts {
  defaultProvider(): string;
  platform(): string;
}

/**
 * 「这台机器上搬得了吗」—— 诊断第 ⑧ 项用得到的**全部**。
 *
 * ⚠️ 与 `ConnectivityProbe.ProxySource` 同一条：依赖声明成这个而不是
 * `PresetImageProvisioner` 本身，因为检查项确实只用得上这一个读。收窄的直接好处在测试里：
 * 替身写 `{ plan: () => … }` 就够，**不必打 `as unknown as` 双重断言** —— 而那个断言一旦
 * 打下去，将来搬运器改了签名，替身也不会红。
 *
 * ⛔ 这条注释不是事后追认：第一版就是靠双重断言过的，被仓库自己的 `no-restricted-syntax`
 * 规则当场拦下（2026-09-05）。⇒ 改生产代码的依赖声明，而不是给测试找一个绕法。
 */
export interface ProvisionPlanner {
  plan(): Promise<ProvisionPlan>;
}

export class ProvisionNotPossibleError extends Error {}
export class ProvisionInFlightError extends Error {}

@Injectable()
export class PresetImageProvisioner {
  private readonly log = new Logger(PresetImageProvisioner.name);
  /** ⚠️ 并发闸：两条流同时往 registry 写同一个 tag 是竞态（10 §6 那条 409）。 */
  private inFlight = false;

  constructor(
    private readonly docker: PresetImageDockerPort,
    private readonly assets: AssetsDirSource,
    private readonly host: HostFacts,
    private readonly seeder: ImageSeedPort,
  ) {}

  /**
   * 定计划 —— 查三个事实，交给纯函数判。
   *
   * ⚠️ **查事实时的异常一律降级成「这条路没有」，不向上抛。** 定计划本身是只读的探查，
   * 它失败了应当让用户看到「搬不了，原因是……」，而不是让诊断整项炸掉 —— 那会把一个
   * 可降级的问题升级成不可用。
   */
  async plan(): Promise<ProvisionPlan> {
    const ref = builtinImageRef();
    const inLocalDocker = await this.safeHasLocalImage(ref);
    const asset = await this.safePickAsset();
    return planProvision({ ref, inLocalDocker, asset });
  }

  private async safeHasLocalImage(ref: string): Promise<boolean> {
    try {
      if (!(await this.docker.available())) return false;
      return await this.docker.hasImage(ref);
    } catch (e) {
      this.log.debug(`探本机 docker 镜像库失败，按「没有」处理：${(e as Error).message}`);
      return false;
    }
  }

  private async safePickAsset(): Promise<ReleaseAsset | null> {
    const dir = this.assets.assetsDir();
    if (dir === undefined || dir.trim() === '') return null;
    try {
      const all = await readAssetManifest(dir);
      return pickAsset(all, this.host.defaultProvider(), this.host.platform());
    } catch (e) {
      this.log.debug(`读资产清单失败，按「没有」处理：${(e as Error).message}`);
      return null;
    }
  }

  /**
   * 真的搬。逐阶段 yield，调用方（SSE 控制器）原样转发。
   *
   * ⚠️ **`build-only` 在这里必须拒**，而不是"尽力试试"：那一格的定义就是字节够不着，
   * 试也只会在几分钟后以一个更难懂的错误失败。
   */
  async *provision(): AsyncGenerator<ProvisionEvent> {
    if (this.inFlight) {
      throw new ProvisionInFlightError(
        '已经有一次搬运在进行中。⚠️ 这一步不是幂等的：两条流同时往 registry 写同一个 tag 是竞态',
      );
    }
    this.inFlight = true;
    try {
      yield* this.run();
    } finally {
      // ⚠️ `finally` 而不是末尾——中途抛出（校验失败）也必须放闸，否则一次失败会把
      //    这个端点**永久**锁死，而用户看到的是「已经有一次搬运在进行中」这种假话。
      this.inFlight = false;
    }
  }

  private async *run(): AsyncGenerator<ProvisionEvent> {
    const ref = builtinImageRef();
    yield ev('plan', 'running', '正在判断这张镜像的字节够不够得着…');
    const plan = await this.plan();
    if (!plan.provisionable) {
      yield ev('plan', 'failed', plan.why);
      throw new ProvisionNotPossibleError(plan.why);
    }
    yield ev('plan', 'ok', `${plan.why}（${plan.from} → ${plan.to}）`);

    if (plan.source === 'local-docker') {
      // 字节已经在本机，`fetch`/`verify`/`load` 三步都不发生 —— ⛔ 如实报 skipped，
      // 不把它们画成"瞬间完成的 ✅"：那会让用户以为下载校验都做过了。
      yield ev('fetch', 'skipped', '字节已在本机 docker 镜像库，无需下载');
      yield ev('verify', 'skipped', '本机镜像不经过资产校验（它不是从清单来的）');
      yield ev('load', 'skipped', '无需装载');
    } else {
      const asset = plan.asset!;
      const dir = this.assets.assetsDir()!;
      // ⛔ **真的查，不是宣称。** 此前这里直接报 ok，文件缺失会在下一阶段以 ENOENT 冒出来
      //    —— 把「资产没下载」归到了「校验失败」头上，而两者的下一步完全不同。
      yield ev('fetch', 'running', `正在确认资产在本机：${asset.asset}…`);
      await assetPresent(dir, asset);
      yield ev('fetch', 'ok', `资产已在本机：${asset.asset}（${mib(asset.sizeBytes)}）`);

      yield ev('verify', 'running', `正在校验 sha256（${mib(asset.sizeBytes)}）…`);
      await verifyAsset(dir, asset);
      yield ev('verify', 'ok', `sha256 对得上：${asset.sha256.slice(0, 12)}…`);

      yield* this.loadAsset(dir, asset, ref);
    }

    yield ev('register', 'running', `正在推送到 ${plan.to}…`);
    // ⛔ 边跑边发。收进数组等结束再喷是**回放不是进度**（见 `callback-stream.ts` 顶部）。
    yield* streamed<ProvisionEvent>((emit) =>
      this.docker.push(ref, (p, msg) => {
        emit(ev('register', 'running', msg, p));
      }),
    );

    // ⛔ **推完还要注册**，否则链条只是从第 2 步挪到第 4 步（见 `ImageSeedPort` 注释）。
    yield ev('register', 'running', '已推送，正在注册进平台（解析 digest + 血统）…');
    await this.seeder.seed();
    yield ev('register', 'ok', `已推送到 ${plan.to} 并注册进平台 —— 重新诊断即可看到第 ⑧ 项转 ✅`);
  }

  private async *loadAsset(
    dir: string,
    asset: ReleaseAsset,
    targetRef: string,
  ): AsyncGenerator<ProvisionEvent> {
    if (asset.kind !== 'docker-archive') {
      // ⚠️ `oci-layout` 的装载路径（boxlite 直接吃 OCI 目录，不经 docker）还没做。
      //    ⛔ 如实说，不假装：见 `provision-plan.ts` 对 `upstream-copy` 的同一条纪律。
      throw new ProvisionNotPossibleError(
        `资产 kind='${asset.kind}' 的装载路径还没实现（当前只支持 docker-archive）。` +
          '⛔ 平台如实说搬不了，而不是试一半留下半张镜像',
      );
    }
    const path = `${dir}/${asset.asset}`;
    yield ev('load', 'running', `正在装载 ${asset.asset}…`);
    yield* streamed<ProvisionEvent>((emit) =>
      this.docker.loadArchive(path, (p, msg) => {
        emit(ev('load', 'running', msg, p));
      }),
    );
    // 装进来的名字是清单里的 `image`，而平台要用的是 `SANDBOX_DEFAULT_IMAGE`。
    // ⚠️ 不打这个标签，push 会推一个平台根本不看的坐标 —— 搬完了诊断照样红。
    if (asset.image !== targetRef) {
      await this.docker.tag(asset.image, targetRef);
      yield ev('load', 'ok', `已装载并打标签：${asset.image} → ${targetRef}`);
    } else {
      yield ev('load', 'ok', `已装载：${asset.image}`);
    }
  }
}

function ev(
  stage: ProvisionStage,
  status: ProvisionEvent['status'],
  message: string,
  progress: number | null = null,
): ProvisionEvent {
  return { stage, status, message, progress };
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}
