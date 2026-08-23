// 启动对账的**实例作用域**（本轮新增）。
//
// 旧规则："带 `platform.managed=true` 但不在库里的容器 = 孤儿，强制删"。这在
// "一台机器一个平台实例"的假设下成立，而那个假设**在开发机上不成立**：e2e 用自己的
// 临时库跑，于是开发者正开着的 demo 的沙箱在它眼里全是孤儿，一跑测试就被清空。
// 实际发生过三次，其中两次是在用户有任务在跑的时候。
//
// 修法不是"跑测试前记得关 demo"（那是纪律，靠不住），而是把"孤儿"收窄到**本实例
// 管的容器** —— 语义上本来也该如此：一个实例凭什么去删另一个实例的东西。
import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import {
  platformInstanceId,
  boxliteNamePrefix,
  INSTANCE_LABEL,
} from '../../src/infrastructure/reconcile/instance-id';
import { BoxliteSandboxProvider } from '../../src/infrastructure/providers/boxlite/boxlite-sandbox.provider';

/**
 * 调**真正的生产者**造名字，而不是在测试里手写一遍格式。
 *
 * ⚠️ 第一版就是手写的，结果"provider 漏掉实例段"这个变异**照样全绿** —— 断言的是
 * 格式的副本，不是产出格式的那段代码（12 §3.4 同一课）。私有方法用 Reflect 取
 * （仓规禁止 `as unknown as` 双重断言），也不为一条用例去放宽生产代码的可见性。
 */
function realBoxName(sandboxId: string): string {
  const provider = new BoxliteSandboxProvider();
  const fn = Reflect.get(provider, 'boxName') as (id: string) => string;
  return fn.call(provider, sandboxId);
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('platformInstanceId — 身份取自"哪个库在裁决孤儿"', () => {
  it('同一个库 ⇒ 同一个身份（重启前后、多进程必须互认）', () => {
    process.env['DATABASE_URL'] = '/srv/agent-platform/data/platform.db';
    const a = platformInstanceId();
    process.env['DATABASE_URL'] = '/srv/agent-platform/data/platform.db';
    expect(platformInstanceId()).toBe(a);
  });

  it('⚠️ 不同的库 ⇒ 不同身份 —— 这正是 e2e 不该碰 demo 容器的那一位', () => {
    process.env['DATABASE_URL'] = '/tmp/s6demo/data/platform.db';
    const demo = platformInstanceId();
    process.env['DATABASE_URL'] = '/tmp/vitest-e2e-xyz/platform.db';
    expect(platformInstanceId()).not.toBe(demo);
  });

  it('DATABASE_URL 缺席时回落到 DATA_ROOT/platform.db（与 env.ts 同口径）', () => {
    delete process.env['DATABASE_URL'];
    process.env['DATA_ROOT'] = '/srv/a';
    const viaRoot = platformInstanceId();
    process.env['DATABASE_URL'] = '/srv/a/platform.db';
    delete process.env['DATA_ROOT'];
    expect(platformInstanceId()).toBe(viaRoot);
  });

  it('⚠️ `:memory:` 不能退化成全局常量 —— 19 个 e2e 文件把它当标准配置', () => {
    // 内存库没有"位置"可言：按字符串哈希算，所有用它的进程会得到**同一个**指纹，
    // 于是"按实例过滤"形同虚设。两次独立的 `pnpm test:e2e` 共享同一个 docker daemon
    // 时会互相把对方正在跑的容器当孤儿删掉 —— 正是本模块要修的那类事故。
    process.env['DATABASE_URL'] = ':memory:';
    const id = platformInstanceId();
    // 同进程内必须恒定：打标签与过滤用的得是同一个值。
    expect(platformInstanceId()).toBe(id);
    // 而它不能等于"把 ':memory:' 这个字符串直接哈希"的结果——那正是退化本身。
    const naive = createHash('sha256').update(':memory:').digest('hex').slice(0, 16);
    expect(id).not.toBe(naive);
  });

  it('标签值短且只做相等比较（16 位十六进制）', () => {
    process.env['DATABASE_URL'] = '/x/y.db';
    expect(platformInstanceId()).toMatch(/^[0-9a-f]{16}$/);
    expect(INSTANCE_LABEL).toBe('platform.instance');
  });
});

describe('boxlite 的名字与 reconciler 的前缀必须同源', () => {
  it('provider 造的名字，能被 reconciler 的 minePrefix 认出来', () => {
    process.env['DATABASE_URL'] = '/srv/a/platform.db';
    const produced = realBoxName('sbx-42');
    // ⚠️ 断言的**两侧都取自真来源**：生产者经 Reflect 调 `boxName()`，解析侧调
    // reconciler 用的同一个 `boxliteNamePrefix()`。第一版这里手写 `platform-boxlite-`，
    // 于是它钉住的是「生产者 ↔ 测试」，钉不住「生产者 ↔ reconciler」——改后者的常量
    // 测试照样绿，而线上一个 box 都不回收。
    const minePrefix = boxliteNamePrefix();

    expect(produced.startsWith(minePrefix)).toBe(true);
    expect(produced.slice(minePrefix.length)).toBe('sbx-42');
  });

  it('⚠️ 别的实例造的名字，本实例认不出来（互不回收）', () => {
    process.env['DATABASE_URL'] = '/srv/a/platform.db';
    const mine = boxliteNamePrefix();
    process.env['DATABASE_URL'] = '/tmp/e2e/platform.db';
    const theirs = realBoxName('sbx-42');

    expect(theirs.startsWith(mine)).toBe(false);
  });

  it('⚠️ 旧格式（无实例段）不被任何实例认领 —— 宁可漏收，不可误删', () => {
    process.env['DATABASE_URL'] = '/srv/a/platform.db';
    const mine = boxliteNamePrefix();
    // 本改动之前建的 box：`platform-boxlite-<sandboxId>`
    expect('platform-boxlite-sbx-42'.startsWith(mine)).toBe(false);
  });
});
