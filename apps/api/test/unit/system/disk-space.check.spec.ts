import { describe, it, expect } from 'vitest';
import {
  cleanupCommandOf,
  DiskSpaceCheck,
} from '../../../src/platform/system/diagnostics/checks/disk-space.check';
import { presetImageSizeText } from '../../../src/platform/system/diagnostics/checks/substrate';
import type { ProviderRegistry } from '@platform/contracts';

/**
 * 磁盘余量那一项的**说法**。
 *
 * ── 本组修的是两条同型缺陷（2026-09-11）───────────────────────────────────────
 *
 * ⛔ **①「预制镜像一张约 13GB」写死。** 那是容器档（aio）的数字；轻量虚拟机档的镜像
 * 压缩后 **0.3GB**，差 40 倍。在一台还剩 5GB 的 mac 上，那句话把「够用」说成了
 * 「拉不下来」——「体积必须按档说」这条纪律在这一项上被漏掉了。
 *
 * ⛔ **② 两句互斥的档位假设同屏**：无条件给 `docker image prune`，紧接着又无条件提
 * 「boxlite 的 rootfs 缓存」。一台机器只可能是其中一档，两句话必有一句在撒谎；
 * 而 `docker` 那句还会把一台根本没有 docker 的 mac 推向去装 docker
 * （`substrate.ts` 记的是同一个坑）。
 *
 * ⚠️ 这里测的是**按档取的那两个纯判定**，不是那次真实的 statfs —— 磁盘水位取决于跑
 * 测试的那台机器，钉它等于让用例的结论取决于运气。
 */
describe('清理建议按档分岔（⛔ 两句互斥的档位假设不许同屏）', () => {
  it('⭐ 容器档才给 docker 命令', () => {
    // MUTATION: 把 `cleanupCommandOf` 改回无条件返回 docker 那句 ⇒ 下一条红。
    expect(cleanupCommandOf('aio')).toEqual({ command: 'docker image prune' });
  });

  it('⭐ 轻量虚拟机档**一个字都不提 docker** —— 那台机器上通常根本没有 docker', () => {
    expect(cleanupCommandOf('boxlite')).toEqual({});
  });

  it('⛔ 认不出的沙箱环境也不给 docker（不知道它靠什么跑，就别猜）', () => {
    expect(cleanupCommandOf('acme-vm')).toEqual({});
  });

  it('三档的命令不是同一个值（合成一句就等于没做这次分岔）', () => {
    const values = ['aio', 'boxlite', 'acme-vm'].map((t) => JSON.stringify(cleanupCommandOf(t)));
    expect(new Set(values).size).toBe(2);
  });
});

describe('体积按档说（⛔ 不许拿另一档的数字吓人）', () => {
  it('⭐ 两档的体积差一个数量级，文案必须跟着差', () => {
    // MUTATION: 让 `presetImageSizeText` 恒返回 13GB 那句 ⇒ 本条红。
    expect(presetImageSizeText('boxlite')).toContain('0.3GB');
    expect(presetImageSizeText('aio')).toContain('13GB');
    expect(presetImageSizeText('boxlite')).not.toContain('13GB');
  });

  it('⛔ 第三方沙箱环境说不出体积就回 null —— 「不知道」不许说成某个具体数字', () => {
    expect(presetImageSizeText('acme-vm')).toBeNull();
  });
});

describe('DiskSpaceCheck 的上屏形状', () => {
  const registry = (name: string): ProviderRegistry => ({
    register: () => undefined,
    get: () => {
      throw new Error('本项不该 get provider');
    },
    has: () => false,
    list: () => [],
    defaultProvider: name,
  });

  it('label 与 headline 都不带 DATA_ROOT 这个字段名，headline ≤ 20 字且无 markdown', async () => {
    const check = new DiskSpaceCheck(registry('boxlite'));
    expect(check.label).not.toContain('DATA_ROOT');

    // 本机真跑一次：水位因机器而异，所以只断言**形状**，不断言某个具体结论。
    const r = await check.run();
    expect([...r.headline].length, r.headline).toBeLessThanOrEqual(20);
    expect(r.headline).not.toContain('\n');
    expect(r.headline).not.toContain('DATA_ROOT');
    const text = `${r.headline}${r.detailText ?? ''}${r.nextStep ?? ''}`;
    expect(text, text).not.toContain('**');
    // ⛔ 这台机器的沙箱环境不是容器档 ⇒ 整段文案里一个 docker 都不该出现。
    expect(`${text}${r.command ?? ''}`).not.toContain('docker');
  });

  it('⭐ 换成容器档 ⇒ 同一台机器上的建议里才可以出现回收镜像层那句', async () => {
    const r = await new DiskSpaceCheck(registry('aio')).run();
    // 磁盘充足时不给下一步（没有要做的事就别给一条要做的事）——所以这里只钉否定面：
    // 一旦给了下一步，它必须是容器档那一版。
    if (r.nextStep !== undefined) {
      expect(r.nextStep).toContain('容器');
      expect(r.command).toBe('docker image prune');
    }
    expect(r.detail?.tier).toBe('aio');
  });
});
