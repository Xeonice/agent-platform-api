import { describe, it, expect } from 'vitest';
import { missingToolAdvice } from '../../../src/platform/system/diagnostics/checks/port-conflict.check';

/**
 * 「这一项查不了」时给什么下一步 —— **必须按平台分岔**（2026-09-11）。
 *
 * ⛔ 上一版无条件给 `apt-get install -y lsof`。macOS 上那条命令**执行不了**（没有 apt），
 * 而 macOS 恰恰是本平台默认沙箱环境的宿主之一 —— 一条执行不了的命令比不给命令更贵。
 * 这是 `connectivity.probe.ts#hintFor`（「别把人支去装 docker」）与
 * `preset-image.check.ts#stageNextStep`（「别给一条拿不到锁的命令」）的**同一条纪律**，
 * 而这里漏了一处。
 *
 * ⚠️ 更细的一点：mac **自带 lsof**，走到这一格说明它存在但看不到别的用户的进程 ⇒
 * 该说的是权限，不是安装。给一条「安装它已经有的东西」的命令是第二重错。
 *
 * ⚠️ 纯函数单独测，因为「这台机器有没有 lsof」取决于跑测试的机器 —— 钉那个等于让
 * CI 与开发机各测一半（与 `reflinkStrategy` / `microVmPlan` 同一条）。
 */
describe('missingToolAdvice —— 按平台分岔，⛔ 不给执行不了的命令', () => {
  it('⭐ macOS：说权限，**不给 apt-get**（那条命令在这台机器上跑不了）', () => {
    // MUTATION: 把 `missingToolAdvice` 改回无条件返回 apt-get 那句 ⇒ 本条红。
    const a = missingToolAdvice('darwin');
    expect(a.command, '⛔ mac 上不许给命令：lsof 本来就在，缺的是权限').toBeUndefined();
    expect(a.nextStep).toContain('权限');
    expect(a.nextStep).not.toContain('apt-get');
  });

  it('Linux：给 apt-get（那一档这条命令是对的）', () => {
    const a = missingToolAdvice('linux');
    expect(a.command).toBe('apt-get install -y lsof');
    // ⚠️ 命令归 command（等宽 + [复制]），散文归 nextStep —— 拆开的全部理由。
    expect(a.nextStep).not.toContain('apt-get');
  });

  it('⛔ 认不出的平台**不编一条安装命令** —— 它的包管理器叫什么我们不知道', () => {
    for (const os of ['win32', 'freebsd', 'sunos']) {
      const a = missingToolAdvice(os);
      expect(a.command, os).toBeUndefined();
      expect(a.nextStep.length, os).toBeGreaterThan(0);
    }
  });

  it('三种平台的下一步两两不同（合并任意两种都会在这里红）', () => {
    const steps = ['darwin', 'linux', 'win32'].map((os) => missingToolAdvice(os).nextStep);
    expect(new Set(steps).size).toBe(3);
  });

  it('⛔ 上屏文案里一个 markdown 星号都不许有', () => {
    for (const os of ['darwin', 'linux', 'win32']) {
      const a = missingToolAdvice(os);
      expect(`${a.nextStep}${a.command ?? ''}`, os).not.toContain('**');
    }
  });
});
