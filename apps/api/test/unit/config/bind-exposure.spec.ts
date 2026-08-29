import { describe, it, expect } from 'vitest';
import { describeBindExposure, isExposedBind } from '../../../src/platform/config/env';

/**
 * ⭐ 「绑在 0.0.0.0」那条告警 —— 它在 compose 形态下**必然出现、又必然不代表出错**
 * （compose 自己设 `HOST=0.0.0.0`，外侧由 `ports: 127.0.0.1:3000:3000` 收住）。
 *
 * ⚠️ 一条恒真的告警不是「多一句话」，它训练用户忽略告警 —— 而这条告警存在的全部理由
 * 是有朝一日真的有人把一个持有用户凭证的实例挂到公网上时它能被看见（审计 P0-3）。
 *
 * ⚠️ 判定被抽成纯函数单独测（与 `reflinkStrategy(os)` 同一手法）：它在本机永远走
 * loopback 那一支，写在 `main.ts` 里的话没有任何断言碰得到另外两支。
 */
describe('绑定地址的暴露判定', () => {
  it('loopback ⇒ 一句都不打（今天的行为，一字不变）', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(isExposedBind(host)).toBe(false);
      expect(describeBindExposure(host, undefined).level).toBe('none');
      // ⚠️ 即使有人给 loopback 也填了声明，也不该冒出一条 INFO —— 没有暴露就没有话说。
      expect(describeBindExposure(host, 'compose ports').level).toBe('none');
    }
  });

  it('⭐ 通配地址 + 没有任何声明 ⇒ WARN（这条不许被削弱）', () => {
    // MUTATION: 把默认支改成 'declared' 或 'none' ⇒ 本条红。这是 P0-3 那条告警本身。
    const e = describeBindExposure('0.0.0.0', undefined);
    expect(e.level).toBe('warn');
    expect(e.level === 'warn' && e.message).toContain('0.0.0.0');
    // 告警得告诉人怎么让它**正当地**闭嘴，否则下一步只有「忍着」或「改代码」。
    expect(e.level === 'warn' && e.message).toContain('HTTP_BIND_GATED_BY');
  });

  it('⭐ 空串 / 只有空白的声明 = 没声明 ⇒ 仍是 WARN', () => {
    // MUTATION: 去掉 `.trim()` 或用 `!== undefined` 判断 ⇒ 本条红。
    // `HTTP_BIND_GATED_BY=` 是 compose/.env 里表达「我没填」最常见的写法，把它当成
    // 一句声明 = 让一个空等号关掉一条安全告警（与 SANDBOX_DOCKER_NETWORK 那条同源）。
    expect(describeBindExposure('0.0.0.0', '').level).toBe('warn');
    expect(describeBindExposure('0.0.0.0', '   ').level).toBe('warn');
  });

  it('⭐ 有显式声明 ⇒ 降为 INFO，且把声明**原样**打出来', () => {
    // MUTATION: 把 declared 那支的 message 改成不含声明原文 ⇒ 本条红。
    // 原样打出来是这个设计能成立的关键：日志里留下的是运维方自己写的那句话，
    // 平台没有替他做任何假设，事后审计看得见签的是什么字。
    const e = describeBindExposure('0.0.0.0', 'compose ports 127.0.0.1:3000');
    expect(e.level).toBe('declared');
    expect(e.level === 'declared' && e.message).toContain('compose ports 127.0.0.1:3000');
  });

  it('⭐ INFO 那句必须明说「平台验证不了这句声明」', () => {
    // MUTATION: 删掉那半句 ⇒ 本条红。⚠️ 这是这个设计与「加个开关关掉告警」的**唯一**
    // 区别：声明可能是假的（外侧其实发布在通配地址上），平台能保证的只是有人签过字。
    // 不说这一句，就等于用一个 env 把一条安全告警静默掉了。
    const e = describeBindExposure('0.0.0.0', 'reverse proxy only');
    expect(e.level === 'declared' && e.message).toContain('验证不了');
  });
});
