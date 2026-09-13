import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ImageSpecError,
  PRESET_IMAGE_NOT_CONFIGURED,
  PRESET_IMAGE_NOT_IN_REGISTRY,
  PRESET_IMAGE_NOT_PLATFORM_BUILT,
  PRESET_IMAGE_NOT_SEEDED,
  REF_NOT_FOUND,
} from '@platform/contracts';
import type {
  ImageFacade,
  ImageSpecProvider,
  ImageSpecRegistry,
  ProviderRegistry,
  RegisteredImageSummary,
  ResolvedImage,
  SandboxProvider,
} from '@platform/contracts';
import { PresetImageCheck } from '../../../src/platform/system/diagnostics/checks/preset-image.check';
import type { ProvisionPlanner } from '../../../src/platform/system/preset-image/preset-image-provisioner';
import type { ProvisionPlan } from '../../../src/platform/system/preset-image/provision-plan';
import type { DiagnoseCheckResult } from '../../../src/platform/system/diagnostics/checks/check.types';

const REF = 'registry.internal/platform/sandbox:v3';
/**
 * ⚠️ 第 3 步的判据 2026-08 从**镜像标签**换成了**平台配置**
 * （`builtinImageDeclaresTmux()`：`SANDBOX_DEFAULT_IMAGE_TMUX` + 平台内置已知镜像表）。
 * 所以「不是那张镜像」现在是靠**换一个平台不认识的坐标**来驱动的，而不是靠摘掉标签。
 * `REF` 落在已知表里（`platform/sandbox`），这才是默认配置下该有的样子。
 */
const UNKNOWN_REF = 'registry.internal/vendor/alpine:3.20';

function resolvedImage(): ResolvedImage {
  return {
    ref: REF,
    digest: 'sha256:abc',
    resolvedAt: '2026-08-28T00:00:00.000Z',
    manifest: {
      name: 'registry.internal/platform/sandbox',
      version: 'v3',
      baseImage: 'upstream',
      entrypointContract: { workdir: '/', entrypoint: ['/bin/sh'] },
      supportedRuntimes: [],
      resourceDefaults: { cores: 1, ramMb: 512, diskMb: 1024 },
      // ⚠️ 空数组，不是 `['platform.tmux']`：第 3 步 2026-08 起不看标签了（看平台配置）。
      // 留一个非空值在这里会让读者以为标签仍然在判定链上。
      labelsRequired: [],
      diffIds: ['sha256:layer'],
    },
  };
}

const registered: RegisteredImageSummary = {
  manifestId: 'man-1',
  ref: REF,
  digest: 'sha256:abc',
  validationStatus: 'valid',
  isActive: true,
  isBuiltin: true,
};

interface Opts {
  resolve?: () => Promise<ResolvedImage>;
  registered?: RegisteredImageSummary | null;
  imageStaged?: SandboxProvider['imageStaged'];
  /** 搬运器说「这台机器上搬得了吗」。缺省 false ⇒ 既有用例仍验**指路**那条分支。 */
  provisionable?: boolean;
  /**
   * 默认档位。缺省 `aio` —— 它在**平台发布表**里，所以「没配 SANDBOX_DEFAULT_IMAGE」
   * 对它不是失败（平台按机器自动选）。要驱动真正的「没配」，传一个第三方 provider。
   */
  defaultProvider?: string;
}

/** 第 2 步的触发条件：registry 解析不到。 */
const rejects = (): Promise<ResolvedImage> =>
  Promise.reject(new Error("image 'x' not found in registry"));

function build(opts: Opts = {}): PresetImageCheck {
  const spec: ImageSpecProvider = {
    name: 'oci',
    resolve: opts.resolve ?? (() => Promise.resolve(resolvedImage())),
    validate: () => ({ valid: true, errors: [], warnings: [] }),
  };
  const specs: ImageSpecRegistry = {
    defaultProvider: 'oci',
    register: () => undefined,
    get: () => spec,
    has: () => true,
    list: () => [spec],
  };
  // ⚠️ 只实现 port 的三个方法（`ImageFacade` 全量），不用双重断言绕过类型 ——
  //    绕过去的那一刻，port 加一个方法这份 double 也不会红。
  const images: ImageFacade = {
    resolveForTask: () => Promise.reject(new Error('本检查不走创建门')),
    findTaskImage: () => Promise.resolve(null),
    findRegisteredByRef: () =>
      Promise.resolve(opts.registered === undefined ? registered : opts.registered),
  };
  // `SandboxProvider` 的六个必需方法本检查一个都不调（它只问 `name` 与 `imageStaged`），
  // 但仍然照形状实现出来 —— 契约变了这里要跟着红，这正是 double 的价值。
  const provider: SandboxProvider = {
    name: opts.defaultProvider ?? 'aio',
    capabilities: {
      spawnTty: true,
      volumeMount: true,
      updateResources: false,
      pauseResume: false,
      snapshot: false,
      watchEvents: false,
      headlessTask: false,
    },
    create: () => Promise.reject(new Error('unused')),
    start: () => Promise.reject(new Error('unused')),
    stop: () => Promise.reject(new Error('unused')),
    destroy: () => Promise.reject(new Error('unused')),
    inspect: () => Promise.reject(new Error('unused')),
    spawn: () => Promise.reject(new Error('unused')),
    ...(opts.imageStaged === undefined ? {} : { imageStaged: opts.imageStaged }),
  };
  const providers: ProviderRegistry = {
    defaultProvider: opts.defaultProvider ?? 'aio',
    register: () => undefined,
    get: () => provider,
    has: () => true,
    list: () => [provider],
  };
  // 搬运器：默认「搬不了」，于是既有用例仍然验的是**指路**那条分支。
  // ⚠️ 要验「够得着就自己搬」的用例自己传 `provisionable: true`（见文件末尾那一组）。
  const provisioner = fakeProvisioner(opts.provisionable ?? false);
  return new PresetImageCheck(specs, images, providers, provisioner);
}

/**
 * 搬运器替身。
 *
 * ⚠️ **只扮演 `plan()` 这一个读**，因为检查项用到的就只有它 —— 与 `ProxySource` 同一条：
 * 替身扮演得越窄，将来被测类改了别的签名时它越不会**假绿**。
 */
function fakeProvisioner(provisionable: boolean): ProvisionPlanner {
  const plan: ProvisionPlan = provisionable
    ? {
        source: 'local-docker',
        provisionable: true,
        sizeBytes: null,
        from: '本机 docker 镜像库',
        to: 'localhost:5001',
        why: '字节已经在本机 docker 镜像库里，只是没推到 registry —— 平台自己推上去即可，不出网、不重建',
        asset: null,
      }
    : {
        source: 'build-only',
        provisionable: false,
        sizeBytes: null,
        from: '（无）',
        to: 'localhost:5001',
        why: '字节在这台机器上够不着：本机 docker 镜像库里没有，发布资产清单也没有匹配这台机器的那一份',
        asset: null,
      };
  return { plan: () => Promise.resolve(plan) };
}

const run = (c: PresetImageCheck): Promise<DiagnoseCheckResult> => c.run();

let saved: string | undefined;
let savedTmux: string | undefined;
beforeEach(() => {
  saved = process.env.SANDBOX_DEFAULT_IMAGE;
  savedTmux = process.env.SANDBOX_DEFAULT_IMAGE_TMUX;
  process.env.SANDBOX_DEFAULT_IMAGE = REF;
  delete process.env.SANDBOX_DEFAULT_IMAGE_TMUX;
});
afterEach(() => {
  if (saved === undefined) delete process.env.SANDBOX_DEFAULT_IMAGE;
  else process.env.SANDBOX_DEFAULT_IMAGE = saved;
  if (savedTmux === undefined) delete process.env.SANDBOX_DEFAULT_IMAGE_TMUX;
  else process.env.SANDBOX_DEFAULT_IMAGE_TMUX = savedTmux;
});

/**
 * 诊断第 ⑧ 项的五步链（P21-5 §9A）。
 *
 * ⛔ **本组的存在理由是那条「不许合成一条」的纪律。** 五步失败的下一步动作完全不同
 * （改配置 / 推镜像 / 换成自建那张 / 重启平台 / 只是等一会），所以每一条用例都同时断言
 * 三样：`step`、`errorCode`、以及**建议里那个可执行的动词**。只断言「status 是 fail」
 * 的用例在五步合成一条之后照样全绿 —— 那恰恰是这一项要防的缺陷。
 */
describe('第 ⑧ 项五步链 —— 每一步说的是不同的话', () => {
  it('⭐ 第 1 步：**内置档没配不是失败** —— 没配才是 2026-09-07 起的出厂状态', async () => {
    // ⛔ 本条此前断言的正相反（没配 ⇒ fail）。那条判据在出厂默认还要运维方自己填坐标时
    //    是对的；平台按机器自动选之后它变成了**假警报**：实测一台两张预制镜像都已播种、
    //    都 valid 的机器，本项仍报「建任务必失败」。
    // ⛔ 而它给的下一步更贵 —— 「SANDBOX_DEFAULT_IMAGE=…」照着填就让自动选永远失效。
    //
    // MUTATION: 把第 1 步改回 `if (!isBuiltinImageConfigured()) fail` ⇒ 本条红。
    delete process.env.SANDBOX_DEFAULT_IMAGE;
    const r = await run(build({ imageStaged: () => Promise.resolve(true) }));
    expect(r.status, '没配 = 让平台按机器自动选,这是正常状态').toBe('ok');
    expect(r.step).toBe('staged');
  });

  it('第 1 步：**真正的没配** = 默认档是第三方 provider,平台没有它的发布镜像', async () => {
    // ⚠️ 这才是「平台不知道该用哪张」的唯一情形。第三方 provider 不在发布表里,
    //    而 04 §8 的纪律是**猜一个比响亮失败更糟**。
    delete process.env.SANDBOX_DEFAULT_IMAGE;
    const r = await run(build({ defaultProvider: 'acme-vm' }));
    expect(r.status).toBe('fail');
    expect(r.step).toBe('config');
    expect(r.errorCode).toBe(PRESET_IMAGE_NOT_CONFIGURED);
    // ⛔ 提示必须是**按档配**,不是 SANDBOX_DEFAULT_IMAGE —— 后者会波及另一档。
    expect(r.command).toContain('SANDBOX_ACME-VM_IMAGE=');
    expect(r.headline).toContain('建不了任务');
    // ⛔ 内部词不许上屏：说「这台机器的沙箱环境」，不说 provider / 档位。
    expect(r.detailText).toContain('这台机器的沙箱环境');
    expect(`${r.headline}${r.detailText ?? ''}`).not.toContain('provider');
  });

  it('第 2 步：registry 里没有 ⇒ 指向推镜像，不是指向改配置', async () => {
    // ⚠️ `registered: null` 是**新设计下走到这一步的前提**：目录里有它就说明注册期
    //    早已过了 registry 这一关,不必再问一次网络（诊断只有 5s 预算,而跨洋往返 10s+）。
    const r = await run(
      build({
        registered: null,
        resolve: () => Promise.reject(new ImageSpecError(REF_NOT_FOUND, 'manifest 404')),
      }),
    );
    expect(r.status).toBe('fail');
    expect(r.step).toBe('registry');
    expect(r.errorCode).toBe(PRESET_IMAGE_NOT_IN_REGISTRY);
    expect(r.command).toContain('docker push');
    // 原始失败原因要带上：401 与 404 与超时的下一步并不相同。
    expect(r.detailText).toContain('manifest 404');
    expect(r.headline).toContain('镜像仓库');
  });

  it('第 3 步：平台不认识又没人声明 ⇒ **必须说清「注册也会被拒」**', async () => {
    process.env.SANDBOX_DEFAULT_IMAGE = UNKNOWN_REF;
    const r = await run(build({ registered: null }));
    expect(r.status).toBe('fail');
    expect(r.step).toBe('lineage');
    expect(r.errorCode).toBe(PRESET_IMAGE_NOT_PLATFORM_BUILT);
    // ⚠️ 这一句是本步的全部价值：不说的话用户会以为只是少做了一步注册，
    //    照着去 POST /api/images 再撞一次墙，而那次撞墙看起来像是他做错了。
    expect(r.detailText).toContain('手动把它加进来同样会被拒');
    expect(r.command).toContain('docker build');
    // ⛔ 「血统」是内部词，上屏说「来源」。
    expect(r.headline).toContain('来源不对');
    expect(`${r.headline}${r.detailText ?? ''}${r.nextStep ?? ''}`).not.toContain('血统');
  });

  it('⭐ 第 3 步：运维方显式声明 ⇒ 一张平台不认识的镜像也放行（自建 / 内网 mirror）', async () => {
    // 没有这条通路，规则就退化成「只有我们发布的那两个名字能用」——那不是安全，是锁死。
    process.env.SANDBOX_DEFAULT_IMAGE = UNKNOWN_REF;
    process.env.SANDBOX_DEFAULT_IMAGE_TMUX = 'true';
    const r = await run(build({ imageStaged: () => Promise.resolve(true) }));
    expect(r.status).toBe('ok');
    expect(r.step).toBe('staged');
  });

  it('第 4 步：没注册进来 ⇒ 指向重启平台等播种（不是叫他手动注册）', async () => {
    const r = await run(build({ registered: null }));
    expect(r.status).toBe('fail');
    expect(r.step).toBe('registration');
    expect(r.errorCode).toBe(PRESET_IMAGE_NOT_SEEDED);
    expect(r.nextStep).toContain('重启平台');
    // ⚠️ 第 3 步刚说过「手动加进来会被拒」，这一步再叫他去注册就是自相矛盾。
    expect(`${r.nextStep ?? ''}${r.command ?? ''}`).not.toContain('POST /api/images');
    // ⛔ 这一档没有可粘贴的命令，就别编一个。
    expect(r.command).toBeUndefined();
  });

  it('第 4 步变体：注册了但 invalid ⇒ 指向重新校验 / 换镜像', async () => {
    const r = await run(build({ registered: { ...registered, validationStatus: 'invalid' } }));
    expect(r.step).toBe('registration');
    // ⛔ `validationStatus: invalid` 是代码字段名，上屏说「没通过平台检查」。
    expect(r.headline).toContain('没通过平台检查');
    expect(`${r.headline}${r.detailText ?? ''}`).not.toContain('invalid');
    expect(r.nextStep).toContain('重新检查');
    // ⛔ manifestId 是第三层，只进 detail。
    expect(`${r.nextStep ?? ''}${r.command ?? ''}`).not.toContain('/validate');
    expect(r.detail?.manifestId).toBeDefined();
  });

  it('第 4 步变体：注册了但停用了 ⇒ 指向 activate', async () => {
    const r = await run(build({ registered: { ...registered, isActive: false } }));
    expect(r.step).toBe('registration');
    expect(r.headline).toContain('停用');
    expect(r.nextStep).toContain('启用');
    expect(`${r.nextStep ?? ''}${r.command ?? ''}`).not.toContain('/activate');
  });

  it('⛔ 四步的码互不相同 —— 「合成一条镜像不可用」在这里就通不过', async () => {
    delete process.env.SANDBOX_DEFAULT_IMAGE;
    const step1 = await run(build({ defaultProvider: 'acme-vm' }));
    process.env.SANDBOX_DEFAULT_IMAGE = REF;
    const step2 = await run(
      build({
        registered: null,
        resolve: () => Promise.reject(new ImageSpecError(REF_NOT_FOUND, 'x')),
      }),
    );
    process.env.SANDBOX_DEFAULT_IMAGE = UNKNOWN_REF;
    const step3 = await run(build({ registered: null }));
    process.env.SANDBOX_DEFAULT_IMAGE = REF;
    const step4 = await run(build({ registered: null }));
    const codes = [step1, step2, step3, step4].map((r) => r.errorCode);
    expect(new Set(codes).size).toBe(4);
    const steps = [step1, step2, step3, step4].map((r) => r.step);
    expect(steps).toEqual(['config', 'registry', 'lineage', 'registration']);
    // 建议也必须各不相同 —— 码分开了而话一样，用户看到的仍然是同一个红灯。
    expect(new Set([step1, step2, step3, step4].map((r) => r.nextStep)).size).toBe(4);
    // headline 同样四句不同，且都 ≤ 20 字、不换行、无 markdown。
    const heads = [step1, step2, step3, step4].map((r) => r.headline);
    expect(new Set(heads).size).toBe(4);
    for (const h of heads) {
      expect([...h].length, h).toBeLessThanOrEqual(20);
      expect(h).not.toContain('\n');
      expect(h).not.toContain('**');
    }
  });
});

describe('第 5 步 —— 未 staged 不是失败', () => {
  it('已 staged ⇒ ok，并明说可以立即发起任务', async () => {
    const r = await run(build({ imageStaged: () => Promise.resolve(true) }));
    expect(r.status).toBe('ok');
    expect(r.step).toBe('staged');
    expect(r.headline).toContain('立即');
  });

  it('⛔ 未 staged ⇒ **info**，不是 warn —— 渲染成 ⚠️ 会让用户去修一个不需要修的东西', async () => {
    const r = await run(build({ imageStaged: () => Promise.resolve(false) }));
    expect(r.status).toBe('info');
    expect(r.step).toBe('staged');
    // 它不是错误，所以**没有错误码**。
    expect(r.errorCode).toBeUndefined();
    // 告知的是「要等多久」，**实测数字必须在**（否则「稍等」等于没说）。
    // ⚠️ 2026-09-07：这个数字改成了**按档**，所以别再断言某一句固定文案 ——
    //    断言的是「有一个量化的等待」。默认档 aio ⇒ 190 秒那一份。
    expect(r.detailText).toMatch(/\d+\s*秒/);
    expect(r.detailText).toContain('190 秒');
  });

  it('provider 没实现 imageStaged ⇒ 说「不报告」，不假装 false', async () => {
    // ⚠️ 契约原文：「不知道」不是 `false`。一个错的 `false` 会承诺一次多分钟的等待，
    //    而这里更糟的方向是错的 `true`：把用户丢回一个静默的 190 秒转圈。
    const r = await run(build());
    expect(r.status).toBe('ok');
    expect(r.detail?.staged).toBeNull();
    // ⛔ 「不知道」不许说成「没有」。
    expect(r.detailText).toContain('不报告');
    expect(r.detailText).not.toContain('还没下载');
  });

  it('imageStaged 这一次答不上来（reject）⇒ 照实转达，不替它猜', async () => {
    const r = await run(
      build({ imageStaged: () => Promise.reject(new Error('store unreadable')) }),
    );
    expect(r.status).toBe('ok');
    expect(r.detail?.staged).toBeNull();
    expect(r.detailText).toContain('store unreadable');
    expect(r.detailText).toContain('问不出');
  });
});

describe('第 2 步：⛔ 够得着就自己搬，不许再让用户去敲命令（2026-09-05 订正）', () => {
  it('⛔ 本机 docker 库已有 ⇒ hint 指向 [准备镜像]，**不出现 docker build**', async () => {
    const r = await run(build({ registered: null, resolve: rejects, provisionable: true }));
    expect(r.step).toBe('registry');
    // 本次事故的形态：字节就在本机，而下一步让用户重新 build 一遍已经有的东西。
    expect(`${r.nextStep ?? ''}${r.command ?? ''}`).not.toContain('docker build');
    expect(r.nextStep).toContain('[准备镜像]');
    expect(r.command, '⛔ 能点按钮就别给命令').toBeUndefined();
  });

  it('搬不了时**保留**原来的指路（那一格的原决定是对的）', async () => {
    const r = await run(build({ registered: null, resolve: rejects, provisionable: false }));
    expect(r.command).toContain('docker build');
    expect(r.command).toContain('docker push');
  });

  it('两条分支的 hint 必须不同 —— 合成一条就等于没做这次订正', async () => {
    const a = await run(build({ registered: null, resolve: rejects, provisionable: true }));
    const b = await run(build({ registered: null, resolve: rejects, provisionable: false }));
    expect(a.nextStep).not.toBe(b.nextStep);
  });

  it('detail 里带出计划，前端据它画按钮（没有它按钮就得自己再问一次）', async () => {
    const r = await run(build({ registered: null, resolve: rejects, provisionable: true }));
    expect((r.detail as { provision?: { provisionable?: boolean } }).provision?.provisionable).toBe(
      true,
    );
  });

  it('⛔ 错误码不因为「能搬」而改变 —— 它说的是「registry 里没有」这个事实', async () => {
    const a = await run(build({ registered: null, resolve: rejects, provisionable: true }));
    const b = await run(build({ registered: null, resolve: rejects, provisionable: false }));
    expect(a.errorCode).toBe(b.errorCode);
    expect(a.status).toBe('fail');
  });
});

/**
 * ⭐ **第 5 步的「怎么提前铺开」必须按档分岔**（2026-09-09 真机发现）。
 *
 * ⛔ 上一版恒为 `docker pull <ref>`。macOS 的默认档是 **boxlite，那台机器上通常没有
 * docker** —— 一条执行不了的命令，还让人以为平台依赖 docker。这与本仓已经写进
 * `connectivity.probe.ts#hintFor` 的教训是同一个坑的另一半：「躲过了『支去配代理』，
 * 却掉进了『支去装 docker』」。
 *
 * MUTATION: 把 `stageHint` 改回恒定的 docker 那句 ⇒ 第一条红。
 */
/**
 * ⭐ **平台自己能铺的时候，一个字都不许教用户去做**（2026-09-10，用户明确要求把这件事
 * 放到向导那一层）。
 *
 * ⛔ 这一格此前恒为「不需要做任何事，第一个任务会自动铺开」—— 读起来像体贴，实际是把
 * 等待挪到了**最差的时机**：用户写完指令、点了发起，然后对着静默进度条等十几到二十分钟
 * （实测这台机器到 ghcr 273 KB/s，boxlite 那张压缩后 320MB）。而且那时它跑在 provision
 * workflow 里，失败就是一个失败的 Task，不是一个能重试的向导步。
 *
 * MUTATION: 把 `stageHint` 的 `canProvisionNow` 分支删掉 ⇒ 前两条红。
 */
describe('★ 未 staged 且平台搬得了 ⇒ 在向导里铺，不再指向第一个任务', () => {
  const notStaged = { imageStaged: () => Promise.resolve(false) };

  it('⭐ hint 指向 [准备镜像]，⛔ 不再说「第一个任务会自动铺开」', async () => {
    const r = await run(build({ ...notStaged, provisionable: true }));
    expect(r.status).toBe('info');
    expect(r.nextStep).toContain('准备镜像');
    expect(r.nextStep).not.toContain('第一个任务会自动');
  });

  it('⭐ detail 必须带上 provision 计划 —— 前端据它才给得出那个按钮', async () => {
    const r = await run(build({ ...notStaged, provisionable: true }));
    const provision = (r.detail as { provision?: { provisionable?: boolean } }).provision;
    expect(provision?.provisionable).toBe(true);
  });

  it('搬不了时才回到按档指路（⛔ 那两条分支不许被这次改动顺手删掉）', async () => {
    const r = await run(build({ ...notStaged, provisionable: false, defaultProvider: 'boxlite' }));
    expect(r.nextStep).not.toContain('准备镜像');
    expect(r.nextStep).toContain('第一个任务会自动');
    expect(`${r.nextStep ?? ''}${r.command ?? ''}`).not.toContain('docker');
  });
});

describe('第 5 步的下一步动作按档分岔（⛔ boxlite 档不许提 docker）', () => {
  const notStaged = { imageStaged: () => Promise.resolve(false) };

  it('⭐ boxlite 档：不提 docker，也不指使去手动拉（平台运行期独占 ~/.boxlite）', async () => {
    const r = await run(build({ ...notStaged, defaultProvider: 'boxlite' }));
    expect(r.status).toBe('info');
    expect(`${r.nextStep ?? ''}${r.command ?? ''}`).not.toContain('docker');
    expect(r.nextStep).toContain('第一个任务会自动');
    // 「没有手动路」要**说出来**，而不是留白让人自己去试那条会失败的路。
    expect(r.nextStep).toContain('拿不到锁');
    // ⛔ 那一档根本没有可执行的命令 —— 不许编一条。
    expect(r.command).toBeUndefined();
  });

  it('aio 档：仍然给 docker pull（那一档本来就有 docker）', async () => {
    const r = await run(build({ ...notStaged, defaultProvider: 'aio' }));
    // ⚠️ 命令归 command（等宽 + [复制]）—— 那正是拆 hint 的理由。
    expect(r.command).toContain('docker pull');
  });

  it('⛔ 两档都要保留「这一步要 registry 在」—— 铺开本身两档都得去拉', async () => {
    for (const tier of ['boxlite', 'aio']) {
      const r = await run(build({ ...notStaged, defaultProvider: tier }));
      expect(r.nextStep).toContain('要镜像仓库在');
    }
  });
});

describe('⑥ 第 ⑧ 项与第 ⑤ 项不是同一个问题，界面上要说出来（2026-09-05 修）', () => {
  it('⛔ 已 staged ⇒ 明说「此刻不需要 registry」', async () => {
    // 同一屏上第 ⑤ 项可能正报 registry ❌。两个结论**都对**（字节早在本机，registry 只在
    // 拉取时需要），但不说清就会被读成「诊断自相矛盾」，进而两条都不信。
    const r = await run(build({ imageStaged: () => Promise.resolve(true) }));
    expect(r.status).toBe('ok');
    expect(r.detailText).toContain('此刻不需要镜像仓库');
    expect((r.detail as { dependsOnRegistryNow?: boolean }).dependsOnRegistryNow).toBe(false);
  });

  it('⛔ 未 staged ⇒ 反过来，明说这一步**要** registry 在', async () => {
    const r = await run(build({ imageStaged: () => Promise.resolve(false) }));
    expect(r.status).toBe('info');
    expect(r.nextStep).toContain('要镜像仓库在');
    expect((r.detail as { dependsOnRegistryNow?: boolean }).dependsOnRegistryNow).toBe(true);
  });

  it('两格的 dependsOnRegistryNow 必须相反 —— 合成一个值就等于没做这次区分', async () => {
    const staged = await run(build({ imageStaged: () => Promise.resolve(true) }));
    const notYet = await run(build({ imageStaged: () => Promise.resolve(false) }));
    expect((staged.detail as { dependsOnRegistryNow?: boolean }).dependsOnRegistryNow).not.toBe(
      (notYet.detail as { dependsOnRegistryNow?: boolean }).dependsOnRegistryNow,
    );
  });
});

/**
 * ── 目录能回答的，别再去问网络（2026-09-07 实测缺陷）─────────────────────────
 *
 * 出厂默认换成 ghcr.io 上的发布镜像之后，第 2 步那次解析变成 **4 次跨洋往返、实测
 * 10.87s**，而诊断给每一项的预算是 `DIAGNOSE_TIMEOUT_MS = 5s` ⇒ 本项从此**永远**只有
 * 一句「5 秒内没有结果」，一台完全健康的机器也不例外。实测就是这样。
 *
 * ⚠️ 而那次往返问不出新东西：目录里的每一行都是**在注册期走过 registry 解析与血统准入
 * 之后**才写下的。⇒ 目录里有它，那两关当时就过了。
 */
describe('目录里已有 ⇒ 本地作答，一次网络都不发', () => {
  it('⭐ 已注册且可用 ⇒ 不调 resolve（否则 5s 预算下本项永远超时）', async () => {
    // MUTATION: 去掉本地快路径（让第 2 步照旧先去 registry）⇒ 本条红。
    let resolveCalls = 0;
    const r = await run(
      build({
        resolve: () => {
          resolveCalls += 1;
          return Promise.resolve(resolvedImage());
        },
        imageStaged: () => Promise.resolve(true),
      }),
    );
    expect(r.status).toBe('ok');
    expect(resolveCalls, '目录已经回答了这个问题,不该再打一次跨洋往返').toBe(0);
  });

  it('⭐ 目录里**没有** ⇒ 才去问 registry「为什么没有」', async () => {
    // ⚠️ 反面同样要钉：一个「永远不触网」的实现会让第 2/3 步整个失效,
    //    而那两步正是镜像真的拉不到时唯一说得出原因的地方。
    let resolveCalls = 0;
    await run(
      build({
        registered: null,
        resolve: () => {
          resolveCalls += 1;
          return Promise.resolve(resolvedImage());
        },
      }),
    );
    expect(resolveCalls, '目录里没有时,必须由 registry 说出原因').toBe(1);
  });

  it('注册了但 invalid ⇒ 也在本地作答（那同样是目录里的事实）', async () => {
    let resolveCalls = 0;
    const r = await run(
      build({
        registered: { ...registered, validationStatus: 'invalid' },
        resolve: () => {
          resolveCalls += 1;
          return Promise.resolve(resolvedImage());
        },
      }),
    );
    expect(r.step).toBe('registration');
    expect(resolveCalls).toBe(0);
  });
});

describe('首个任务的代价按档说（2026-09-07 实测）', () => {
  it('⭐ boxlite 档不许拿 aio 的 13GB / 190 秒吓人', () => {
    // ⛔ 这句话曾恒为「13GB 镜像实测冷启动约 190 秒」。macOS 默认档是 boxlite，
    //    其镜像压缩后 **0.31GB**（实测）—— 差了一个数量级还多。
    // MUTATION: 把 `firstRunCost(...)` 改回写死的 13GB 那句 ⇒ 本条红。
    return run(
      build({ defaultProvider: 'boxlite', imageStaged: () => Promise.resolve(false) }),
    ).then((r) => {
      expect(r.status).toBe('info');
      expect(r.detailText).not.toContain('13GB');
      expect(r.detailText).toContain('0.3GB');
    });
  });

  it('aio 档仍然说 13GB / 190 秒（那一档这个数字是对的）', () =>
    run(build({ defaultProvider: 'aio', imageStaged: () => Promise.resolve(false) })).then((r) => {
      expect(r.detailText).toContain('13GB');
      expect(r.detailText).toContain('190 秒');
    }));
});
