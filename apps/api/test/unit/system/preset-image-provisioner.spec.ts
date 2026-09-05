import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PresetImageProvisioner,
  ProvisionInFlightError,
  ProvisionNotPossibleError,
  type AssetsDirSource,
  type HostFacts,
  type PresetImageDockerPort,
  type ImageSeedPort,
  type ProvisionEvent,
} from '../../../src/platform/system/preset-image/preset-image-provisioner';

const REF = 'localhost:5001/platform/sandbox:v2';

function dockerStub(over: Partial<PresetImageDockerPort> = {}): PresetImageDockerPort {
  return {
    available: () => Promise.resolve(true),
    hasImage: () => Promise.resolve(false),
    push: () => Promise.resolve(),
    loadArchive: () => Promise.resolve(),
    tag: () => Promise.resolve(),
    ...over,
  };
}
const noAssets: AssetsDirSource = { assetsDir: () => undefined };
const host: HostFacts = { defaultProvider: () => 'boxlite', platform: () => 'linux/arm64' };

function make(
  docker: PresetImageDockerPort = dockerStub(),
  assets: AssetsDirSource = noAssets,
  seeder: ImageSeedPort = { seed: () => Promise.resolve() },
): PresetImageProvisioner {
  return new PresetImageProvisioner(docker, assets, host, seeder);
}

async function collect(p: PresetImageProvisioner): Promise<ProvisionEvent[]> {
  const out: ProvisionEvent[] = [];
  for await (const e of p.provision()) out.push(e);
  return out;
}

beforeEach(() => {
  process.env['SANDBOX_DEFAULT_IMAGE'] = REF;
});

describe('plan —— 查事实失败一律降级成「这条路没有」', () => {
  it('⛔ docker 探测抛错 ⇒ 按「本机没有」处理，**不让诊断整项炸掉**', async () => {
    const p = make(dockerStub({ hasImage: () => Promise.reject(new Error('socket 没了')) }));
    await expect(p.plan()).resolves.toMatchObject({ source: 'build-only' });
  });

  it('docker 不在（boxlite 档的常态）⇒ 不报错，只是少一条路', async () => {
    const p = make(dockerStub({ available: () => Promise.resolve(false) }));
    const plan = await p.plan();
    expect(plan.source).toBe('build-only');
    expect(plan.provisionable).toBe(false);
  });

  it('资产目录没配 ⇒ 不去读文件系统', async () => {
    const spy = vi.fn(() => undefined);
    await make(dockerStub(), { assetsDir: spy }).plan();
    expect(spy).toHaveBeenCalled();
  });

  it('本机有 ⇒ local-docker 且可搬', async () => {
    const p = make(dockerStub({ hasImage: () => Promise.resolve(true) }));
    await expect(p.plan()).resolves.toMatchObject({ source: 'local-docker', provisionable: true });
  });
});

describe('provision —— 阶段是「失败在哪一步」的唯一载体', () => {
  it('本机已有 ⇒ 走完五阶段，且 fetch/verify/load **如实报 skipped**', async () => {
    const evs = await collect(make(dockerStub({ hasImage: () => Promise.resolve(true) })));
    const byStage = (s: string): ProvisionEvent[] => evs.filter((e) => e.stage === s);
    expect(byStage('plan').at(-1)!.status).toBe('ok');
    // ⛔ 不许把没发生的三步画成「瞬间完成的 ✅」——那会让用户以为下载校验都做过了。
    expect(byStage('fetch').at(-1)!.status).toBe('skipped');
    expect(byStage('verify').at(-1)!.status).toBe('skipped');
    expect(byStage('load').at(-1)!.status).toBe('skipped');
    expect(byStage('register').at(-1)!.status).toBe('ok');
  });

  it('⛔ build-only ⇒ 直接拒，**不"尽力试试"**（试也只会几分钟后更难懂地失败）', async () => {
    await expect(collect(make())).rejects.toThrow(ProvisionNotPossibleError);
  });

  it('拒的时候要先发一条 failed 的 plan 事件，前端据它显示原因', async () => {
    const evs: ProvisionEvent[] = [];
    const p = make();
    await expect(
      (async () => {
        for await (const e of p.provision()) evs.push(e);
      })(),
    ).rejects.toThrow();
    expect(evs.at(-1)).toMatchObject({ stage: 'plan', status: 'failed' });
    expect(evs.at(-1)!.message).toContain('够不着');
  });

  it('真的推了，而且推的是 SANDBOX_DEFAULT_IMAGE 那个坐标', async () => {
    const push = vi.fn(() => Promise.resolve());
    await collect(make(dockerStub({ hasImage: () => Promise.resolve(true), push })));
    expect(push).toHaveBeenCalledWith(REF, expect.any(Function));
  });

  it('推送的进度**边跑边发**（不是结束后回放）', async () => {
    const docker = dockerStub({
      hasImage: () => Promise.resolve(true),
      push: (_ref, on) => {
        on(0.5, '推到一半');
        return Promise.resolve();
      },
    });
    const evs = await collect(make(docker));
    expect(evs.some((e) => e.message === '推到一半' && e.progress === 0.5)).toBe(true);
  });
});

describe('并发闸 —— 两条流写同一个 tag 是竞态', () => {
  it('⛔ 已在搬时再调 ⇒ 抛 ProvisionInFlightError', async () => {
    let release!: () => void;
    const docker = dockerStub({
      hasImage: () => Promise.resolve(true),
      push: () =>
        new Promise<void>((r) => {
          release = r;
        }),
    });
    const p = make(docker);
    const first = collect(p);
    // 让第一条跑到 push 那一步
    await new Promise((r) => setTimeout(r, 10));
    await expect(collect(p)).rejects.toThrow(ProvisionInFlightError);
    release();
    await first;
  });

  it('⛔ **中途失败也必须放闸**——否则一次失败把端点永久锁死，还谎称「正在搬运中」', async () => {
    const p = make();
    await expect(collect(p)).rejects.toThrow(ProvisionNotPossibleError);
    // 第二次仍应是「搬不了」，而不是「已经有一次在进行中」
    await expect(collect(p)).rejects.toThrow(ProvisionNotPossibleError);
  });
});

describe('⛔ 推完必须注册 —— 否则只是把「你自己动手」挪到第 4 步', () => {
  it('推送成功后调 seed()（2026-09-05 实跑逮到：搬完了诊断卡在「没有注册记录」）', async () => {
    const seed = vi.fn(() => Promise.resolve());
    await collect(make(dockerStub({ hasImage: () => Promise.resolve(true) }), noAssets, { seed }));
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it('⛔ 顺序是「先推后种」—— 反过来种的时候 registry 里还没有那张镜像', async () => {
    const order: string[] = [];
    const docker = dockerStub({
      hasImage: () => Promise.resolve(true),
      push: () => {
        order.push('push');
        return Promise.resolve();
      },
    });
    await collect(
      make(docker, noAssets, {
        seed: () => {
          order.push('seed');
          return Promise.resolve();
        },
      }),
    );
    expect(order).toEqual(['push', 'seed']);
  });

  it('搬不了时不该去种（没有推任何东西）', async () => {
    const seed = vi.fn(() => Promise.resolve());
    await expect(collect(make(dockerStub(), noAssets, { seed }))).rejects.toThrow();
    expect(seed).not.toHaveBeenCalled();
  });

  it('种失败要冒出来 —— ⛔ 吞掉它就等于谎称搬运成功', async () => {
    const p = make(dockerStub({ hasImage: () => Promise.resolve(true) }), noAssets, {
      seed: () => Promise.reject(new Error('registry 401')),
    });
    await expect(collect(p)).rejects.toThrow('registry 401');
  });
});
