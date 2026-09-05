import { describe, it, expect } from 'vitest';
import { platform } from 'node:os';
import type { ProviderRegistry } from '@platform/contracts';
import {
  DevKvmCheck,
  darwinMicroVmVerdict,
  linuxKvmVerdict,
  microVmPlan,
  type DarwinMicroVmFacts,
} from '../../../src/platform/system/diagnostics/checks/dev-kvm.check';

/**
 * 诊断第 ② 项：**微 VM 档位（boxlite）可用**。
 *
 * ⚠️ **本组的起因是一次「在 boxlite 唯一默认启用的平台上报不适用」**（2026-09-05 实测）：
 * 这一项在 macOS 上报 ℹ️「当前系统是 darwin，没有 /dev/kvm 这个设备 —— 微 VM 档位
 * （boxlite）在此平台不适用」，而 `hostPreferredProvider()` 是 `darwin ? 'boxlite' : 'aio'`
 * —— **mac 上 boxlite 不但适用，还是默认档**，它走的是 Hypervisor.framework，与
 * `/dev/kvm` 无关。同一时刻本机 `~/.boxlite` 的运行时锁正被后端服务持有，也就是说
 * boxlite 就在这台机器上跑着。
 *
 * ⚠️ **两条平台分支都要有用例，且不能依赖跑测试的机器是什么平台** —— CI 是 Linux、
 * 开发机是 macOS。只测「当前平台那一支」等于两边各测一半：Linux 上的行为没人守。
 * 所以下面测的是**纯判定函数**（与第 ⑦ 项 `reflinkStrategy` / `reflinkOutcome` 同款）。
 */
describe('microVmPlan —— 按平台问对的问题', () => {
  it('⛔ darwin 问 Hypervisor.framework，**不是** /dev/kvm（本次事故的根因）', () => {
    // 上一版把「Linux 上的实现细节」当成了「boxlite 的通用前置」。
    expect(microVmPlan('darwin').kind).toBe('hypervisor-framework');
  });

  it('linux 问 /dev/kvm', () => {
    expect(microVmPlan('linux').kind).toBe('kvm-device');
  });

  it('其余平台如实说不支持，且 reason 里**不提 /dev/kvm**（那与结论无关）', () => {
    for (const os of ['win32', 'freebsd']) {
      const p = microVmPlan(os);
      expect(p.kind).toBe('unsupported');
      const reason = p.kind === 'unsupported' ? p.reason : '';
      expect(reason).toContain(os);
      expect(reason).not.toContain('/dev/kvm');
    }
  });

  it('三条分支两两不同（把 darwin 并回「其余平台」会在这里红）', () => {
    const kinds = ['darwin', 'linux', 'win32'].map((os) => microVmPlan(os).kind);
    expect(new Set(kinds).size).toBe(3);
  });
});

const appleSilicon: DarwinMicroVmFacts = {
  arch: 'arm64',
  darwinRelease: '25.5.0',
  hvSupport: true,
  frameworkPresent: true,
};

describe('darwinMicroVmVerdict —— macOS 分支', () => {
  it('⛔ Apple Silicon + macOS 12+ + 框架在 ⇒ **ok**（此前这里恒报「不适用」）', () => {
    const r = darwinMicroVmVerdict(appleSilicon, true);
    expect(r.status).toBe('ok');
    expect(r.summary).toContain('Hypervisor.framework');
    // ⛔ 一个字都不许再说「不适用」——那正是被修掉的那句结论。
    expect(r.summary).not.toContain('不适用');
    expect(r.summary).not.toContain('/dev/kvm');
    // 这一项的全部意义就是**别把人推向 docker**，所以这句话必须在。
    expect(r.summary).toContain('不需要 Docker');
    expect(r.hint).toBeUndefined();
  });

  it('是默认档时要说出来（用户据此知道「开箱即用」的那条路是通的）', () => {
    expect(darwinMicroVmVerdict(appleSilicon, true).summary).toContain('默认档');
    expect(darwinMicroVmVerdict(appleSilicon, false).summary).not.toContain('默认档');
  });

  it('⚠️ Intel Mac ⇒ warn，且 hint 要给出**能走的那条路**（aio）', () => {
    const r = darwinMicroVmVerdict({ ...appleSilicon, arch: 'x64' }, true);
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('Apple Silicon');
    expect(r.hint).toContain('aio');
  });

  it('⚠️ macOS 11（Darwin 20）⇒ warn；macOS 12（Darwin 21）是分界线', () => {
    expect(darwinMicroVmVerdict({ ...appleSilicon, darwinRelease: '20.6.0' }, true).status).toBe(
      'warn',
    );
    expect(darwinMicroVmVerdict({ ...appleSilicon, darwinRelease: '21.0.0' }, true).status).toBe(
      'ok',
    );
  });

  it('⛔ 版本判据是 Darwin 主版本，**不是「Darwin − 9」那张映射表**', () => {
    // macOS 26 = Darwin 25。任何 `major - 9 >= 12` 之类的写法在这里都会把一台
    // 完全合格的机器判成「版本过低」——那个偏移在 macOS 26 上已经断了。
    expect(darwinMicroVmVerdict({ ...appleSilicon, darwinRelease: '25.5.0' }, true).status).toBe(
      'ok',
    );
  });

  it('⚠️ kern.hv_support=0 ⇒ warn（跑在虚拟机里的 macOS 就是这种）', () => {
    const r = darwinMicroVmVerdict({ ...appleSilicon, hvSupport: false }, true);
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('kern.hv_support=0');
  });

  it('⛔ hv_support **问不出来（null）不许判坏** —— 「不知道」不是「不支持」', () => {
    // 与内存那条 `unmeasurable`、reflink 那条三态同一条纪律：一个测不准的读数
    // 绝不该把一台好机器判成坏的。官方列的前置是「macOS 12+ · Apple Silicon」，
    // kern.hv_support 只是佐证。
    const r = darwinMicroVmVerdict({ ...appleSilicon, hvSupport: null }, true);
    expect(r.status).toBe('ok');
    expect(r.detail?.hvSupport).toBeNull();
    // 问不出来时就别把它写进结论里冒充证据。
    expect(r.summary).not.toContain('kern.hv_support');
  });

  it('⚠️ 框架不在 ⇒ warn（正常 macOS 上不该发生）', () => {
    const r = darwinMicroVmVerdict({ ...appleSilicon, frameworkPresent: false }, true);
    expect(r.status).toBe('warn');
    expect(r.detail?.hypervisorFramework).toBeNull();
  });

  it('拦下时**一定**给得出下一步 —— 没有下一步的告警等于没有告警', () => {
    const blocked: DarwinMicroVmFacts[] = [
      { ...appleSilicon, arch: 'x64' },
      { ...appleSilicon, darwinRelease: '20.6.0' },
      { ...appleSilicon, hvSupport: false },
      { ...appleSilicon, frameworkPresent: false },
    ];
    for (const f of blocked) {
      const r = darwinMicroVmVerdict(f, true);
      expect(r.status).toBe('warn');
      expect(r.hint).toBeTruthy();
    }
  });
});

describe('linuxKvmVerdict —— Linux 分支', () => {
  it('可读写 ⇒ ok', () => {
    const r = linuxKvmVerdict(null, false);
    expect(r.status).toBe('ok');
    expect(r.summary).toContain('/dev/kvm');
  });

  it('是默认档时要说出来（与 darwin 那支同一句口径）', () => {
    expect(linuxKvmVerdict(null, true).summary).toContain('默认档');
    expect(linuxKvmVerdict(null, false).summary).not.toContain('默认档');
  });

  it('⛔ ENOENT 与 EACCES 的下一步不同，不许合成一条', () => {
    const missing = linuxKvmVerdict('ENOENT', true);
    const denied = linuxKvmVerdict('EACCES', true);
    expect(missing.status).toBe('warn');
    expect(denied.status).toBe('warn');
    // 设备不在 ⇒ 宿主机没开虚拟化；在但没权限 ⇒ 加用户组。
    expect(missing.hint).toContain('kvm 模块');
    expect(denied.hint).toContain('usermod');
    expect(missing.hint).not.toBe(denied.hint);
  });

  it('errno 要原样带进 detail（排障的下一个问题就是「为什么」）', () => {
    expect(linuxKvmVerdict('EPERM', true).detail?.errno).toBe('EPERM');
  });

  // ── ⛔ 严重程度按「谁需要它」分岔（2026-09-05 补齐 §9F）────────────────────
  it('⛔ 默认档**不是**微 VM ⇒ ℹ️ 而不是 ⚠️ —— 一台跑 aio 的 Linux 机器完全健康', () => {
    // 上一版无条件 warn：那台机器常年顶着一个黄灯，而它根本不走这条路。
    // 无条件要求某个依赖在，与恒 ⚠️ 的噪音项是同一种失败（P21-5 §9D/§9F）。
    const r = linuxKvmVerdict('ENOENT', false);
    expect(r.status).toBe('info');
    expect(r.summary).toContain('当前默认档不需要它');
  });

  it('⛔ 不需要它的时候**不给 hint** —— 没有要做的事，就别给一条要做的事', () => {
    expect(linuxKvmVerdict('ENOENT', false).hint).toBeUndefined();
    expect(linuxKvmVerdict('ENOENT', true).hint).toBeDefined();
  });

  it('默认档是微 VM ⇒ ⚠️，且说清它正是这台机器要走的路', () => {
    const r = linuxKvmVerdict('ENOENT', true);
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('正是这台机器的默认档');
  });

  it('两种默认档下的结论必须不同（合成一条就等于没做这次分岔）', () => {
    expect(linuxKvmVerdict('ENOENT', true).status).not.toBe(
      linuxKvmVerdict('ENOENT', false).status,
    );
  });

  it('isDefaultProvider 要进 detail —— 排障时要能回答「它当时算的是哪一档」', () => {
    expect(linuxKvmVerdict('ENOENT', true).detail?.isDefaultProvider).toBe(true);
    expect(linuxKvmVerdict(null, false).detail?.isDefaultProvider).toBe(false);
  });
});

/** 只有 `defaultProvider` 会被读到 —— 其余方法在这一项里一次都不该被调用。 */
function registryWithDefault(name: string): ProviderRegistry {
  return {
    register: () => undefined,
    get: () => {
      throw new Error('本项不该 get provider');
    },
    has: () => false,
    list: () => [],
    defaultProvider: name,
  };
}

describe('DevKvmCheck.run —— 在这台机器上真跑一次', () => {
  it('id 是跨仓契约的闭集成员，**不动**；label 已不再叫 /dev/kvm', () => {
    const check = new DevKvmCheck(registryWithDefault('boxlite'));
    expect(check.id).toBe('dev-kvm');
    // 一个报 ✅ 的 mac 上，标题写「/dev/kvm 可用」而正文写「Hypervisor.framework 就绪」
    // 是自相矛盾的 —— 而用户先读到的是标题。
    expect(check.label).not.toContain('/dev/kvm');
    expect(check.label).toContain('boxlite');
  });

  it('当前平台上跑通，且结论与 microVmPlan 说的那一支一致', async () => {
    const check = new DevKvmCheck(registryWithDefault('boxlite'));
    const r = await check.run({ timeoutMs: 3000, signal: new AbortController().signal });
    const plan = microVmPlan(platform());

    expect(['ok', 'info', 'warn']).toContain(r.status);
    if (plan.kind === 'hypervisor-framework') {
      // ⛔ 本次事故的回归断言：mac 上**绝不许**再出现「不适用」。
      expect(r.summary).not.toContain('不适用');
      expect(r.detail?.platform).toBe('darwin');
    } else if (plan.kind === 'kvm-device') {
      expect(r.detail?.platform).toBe('linux');
    }
  });
});
