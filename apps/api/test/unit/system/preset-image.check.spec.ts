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
    name: 'aio',
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
    defaultProvider: 'aio',
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
  it('第 1 步：没配 ⇒ 指向改配置，并说清兜底那张为什么必炸', async () => {
    delete process.env.SANDBOX_DEFAULT_IMAGE;
    const r = await run(build());
    expect(r.status).toBe('fail');
    expect(r.step).toBe('config');
    expect(r.errorCode).toBe(PRESET_IMAGE_NOT_CONFIGURED);
    expect(r.hint).toContain('SANDBOX_DEFAULT_IMAGE=');
    // 「没配也有个默认值」听起来像可以先不管 —— 必须说清它建不出任务。
    expect(r.summary).toContain('必失败');
  });

  it('第 2 步：registry 里没有 ⇒ 指向推镜像，不是指向改配置', async () => {
    const r = await run(
      build({ resolve: () => Promise.reject(new ImageSpecError(REF_NOT_FOUND, 'manifest 404')) }),
    );
    expect(r.status).toBe('fail');
    expect(r.step).toBe('registry');
    expect(r.errorCode).toBe(PRESET_IMAGE_NOT_IN_REGISTRY);
    expect(r.hint).toContain('docker push');
    // 原始失败原因要带上：401 与 404 与超时的下一步并不相同。
    expect(r.summary).toContain('manifest 404');
  });

  it('第 3 步：平台不认识又没人声明 ⇒ **必须说清「注册也会被拒」**', async () => {
    process.env.SANDBOX_DEFAULT_IMAGE = UNKNOWN_REF;
    const r = await run(build());
    expect(r.status).toBe('fail');
    expect(r.step).toBe('lineage');
    expect(r.errorCode).toBe(PRESET_IMAGE_NOT_PLATFORM_BUILT);
    // ⚠️ 这一句是本步的全部价值：不说的话用户会以为只是少做了一步注册，
    //    照着去 POST /api/images 再撞一次墙，而那次撞墙看起来像是他做错了。
    expect(r.summary).toContain('注册同样会被准入检查拒');
    expect(r.hint).toContain('docker build');
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
    expect(r.hint).toContain('重启平台');
    // ⚠️ 第 3 步刚说过「手动注册会被拒」，这一步再叫他去注册就是自相矛盾。
    expect(r.hint).not.toContain('POST /api/images');
  });

  it('第 4 步变体：注册了但 invalid ⇒ 指向重新校验 / 换镜像', async () => {
    const r = await run(build({ registered: { ...registered, validationStatus: 'invalid' } }));
    expect(r.step).toBe('registration');
    expect(r.summary).toContain('invalid');
    expect(r.hint).toContain('/validate');
  });

  it('第 4 步变体：注册了但停用了 ⇒ 指向 activate', async () => {
    const r = await run(build({ registered: { ...registered, isActive: false } }));
    expect(r.step).toBe('registration');
    expect(r.hint).toContain('/activate');
  });

  it('⛔ 四步的码互不相同 —— 「合成一条镜像不可用」在这里就通不过', async () => {
    delete process.env.SANDBOX_DEFAULT_IMAGE;
    const step1 = await run(build());
    process.env.SANDBOX_DEFAULT_IMAGE = REF;
    const step2 = await run(
      build({ resolve: () => Promise.reject(new ImageSpecError(REF_NOT_FOUND, 'x')) }),
    );
    process.env.SANDBOX_DEFAULT_IMAGE = UNKNOWN_REF;
    const step3 = await run(build());
    process.env.SANDBOX_DEFAULT_IMAGE = REF;
    const step4 = await run(build({ registered: null }));
    const codes = [step1, step2, step3, step4].map((r) => r.errorCode);
    expect(new Set(codes).size).toBe(4);
    const steps = [step1, step2, step3, step4].map((r) => r.step);
    expect(steps).toEqual(['config', 'registry', 'lineage', 'registration']);
    // 建议也必须各不相同 —— 码分开了而话一样，用户看到的仍然是同一个红灯。
    expect(new Set([step1, step2, step3, step4].map((r) => r.hint)).size).toBe(4);
  });
});

describe('第 5 步 —— 未 staged 不是失败', () => {
  it('已 staged ⇒ ok，并明说可以立即发起任务', async () => {
    const r = await run(build({ imageStaged: () => Promise.resolve(true) }));
    expect(r.status).toBe('ok');
    expect(r.step).toBe('staged');
    expect(r.summary).toContain('立即');
  });

  it('⛔ 未 staged ⇒ **info**，不是 warn —— 渲染成 ⚠️ 会让用户去修一个不需要修的东西', async () => {
    const r = await run(build({ imageStaged: () => Promise.resolve(false) }));
    expect(r.status).toBe('info');
    expect(r.step).toBe('staged');
    // 它不是错误，所以**没有错误码**。
    expect(r.errorCode).toBeUndefined();
    // 告知的是「要等多久」，实测数字要在（190 秒 / 数分钟）。
    expect(r.summary).toContain('数分钟');
  });

  it('provider 没实现 imageStaged ⇒ 说「不报告」，不假装 false', async () => {
    // ⚠️ 契约原文：「不知道」不是 `false`。一个错的 `false` 会承诺一次多分钟的等待，
    //    而这里更糟的方向是错的 `true`：把用户丢回一个静默的 190 秒转圈。
    const r = await run(build());
    expect(r.status).toBe('ok');
    expect(r.detail?.staged).toBeNull();
    expect(r.summary).toContain('不报告');
  });

  it('imageStaged 这一次答不上来（reject）⇒ 照实转达，不替它猜', async () => {
    const r = await run(
      build({ imageStaged: () => Promise.reject(new Error('store unreadable')) }),
    );
    expect(r.status).toBe('ok');
    expect(r.detail?.staged).toBeNull();
    expect(r.summary).toContain('store unreadable');
  });
});

describe('第 2 步：⛔ 够得着就自己搬，不许再让用户去敲命令（2026-09-05 订正）', () => {
  it('⛔ 本机 docker 库已有 ⇒ hint 指向 [准备镜像]，**不出现 docker build**', async () => {
    const r = await run(build({ resolve: rejects, provisionable: true }));
    expect(r.step).toBe('registry');
    // 本次事故的形态：字节就在本机，而 hint 让用户重新 build 一遍已经有的东西。
    expect(r.hint).not.toContain('docker build');
    expect(r.hint).toContain('[准备镜像]');
  });

  it('搬不了时**保留**原来的指路（那一格的原决定是对的）', async () => {
    const r = await run(build({ resolve: rejects, provisionable: false }));
    expect(r.hint).toContain('docker build');
    expect(r.hint).toContain('docker push');
  });

  it('两条分支的 hint 必须不同 —— 合成一条就等于没做这次订正', async () => {
    const a = await run(build({ resolve: rejects, provisionable: true }));
    const b = await run(build({ resolve: rejects, provisionable: false }));
    expect(a.hint).not.toBe(b.hint);
  });

  it('detail 里带出计划，前端据它画按钮（没有它按钮就得自己再问一次）', async () => {
    const r = await run(build({ resolve: rejects, provisionable: true }));
    expect((r.detail as { provision?: { provisionable?: boolean } }).provision?.provisionable).toBe(
      true,
    );
  });

  it('⛔ 错误码不因为「能搬」而改变 —— 它说的是「registry 里没有」这个事实', async () => {
    const a = await run(build({ resolve: rejects, provisionable: true }));
    const b = await run(build({ resolve: rejects, provisionable: false }));
    expect(a.errorCode).toBe(b.errorCode);
    expect(a.status).toBe('fail');
  });
});

describe('⑥ 第 ⑧ 项与第 ⑤ 项不是同一个问题，界面上要说出来（2026-09-05 修）', () => {
  it('⛔ 已 staged ⇒ 明说「此刻不需要 registry」', async () => {
    // 同一屏上第 ⑤ 项可能正报 registry ❌。两个结论**都对**（字节早在本机，registry 只在
    // 拉取时需要），但不说清就会被读成「诊断自相矛盾」，进而两条都不信。
    const r = await run(build({ imageStaged: () => Promise.resolve(true) }));
    expect(r.status).toBe('ok');
    expect(r.summary).toContain('此刻不需要 registry');
    expect((r.detail as { dependsOnRegistryNow?: boolean }).dependsOnRegistryNow).toBe(false);
  });

  it('⛔ 未 staged ⇒ 反过来，明说这一步**要** registry 在', async () => {
    const r = await run(build({ imageStaged: () => Promise.resolve(false) }));
    expect(r.status).toBe('info');
    expect(r.hint).toContain('要 registry 在');
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
