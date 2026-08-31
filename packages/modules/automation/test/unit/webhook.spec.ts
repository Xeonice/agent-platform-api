import { describe, expect, it } from 'vitest';
import { classifyAddress, judge, parseWebhookUrl } from '../../src/domain/services/ssrf.policy';
import { WebhookTarget } from '../../src/domain/value-objects/webhook-target.vo';
import { AutomationInvariantError } from '../../src/domain/errors/automation-errors';

/**
 * webhook 的两半纯逻辑 —— 25 §3.7 的 T-AUT-30 / T-AUT-31。
 *
 * ── 每组断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① `matches` 把 timeout 归到 success 一侧      ⇒ T-AUT-30 红
 *  ② `classifyAddress` 漏掉 169.254/16           ⇒ T-AUT-31 的元数据地址红
 *  ③ `judge` 里私网放行不看 `accessGateEnabled`  ⇒「无口令时私网降级为拒绝」红（P2-12）
 *  ④ `parseWebhookUrl` 放行 ftp/file             ⇒ T-AUT-31 的 `ftp://…` 红
 *  ⑤ IPv4-mapped IPv6 不递归判                   ⇒「::ffff:127.0.0.1 被放行」红
 */
const gated = { allowPrivateNetwork: true, accessGateEnabled: true };
const ungated = { allowPrivateNetwork: true, accessGateEnabled: false };
const noPrivate = { allowPrivateNetwork: false, accessGateEnabled: true };

describe('SSRF 谓词（03 §8.5）', () => {
  it('★ T-AUT-31：环回 / 元数据拒，私网默认放行，非 http(s) 拒', () => {
    expect(judge('127.0.0.1', gated)).toBe('deny-loopback');
    expect(judge('127.53.1.9', gated)).toBe('deny-loopback');
    expect(judge('::1', gated)).toBe('deny-loopback');
    // 云元数据端点 —— 这一条是 SSRF 最经典的目标
    expect(judge('169.254.169.254', gated)).toBe('deny-link-local');
    // 私网：**默认放行**（私有化部署里内网 webhook 是主要用法）
    expect(judge('10.0.0.5', gated)).toBe('allow');
    expect(judge('172.16.3.4', gated)).toBe('allow');
    expect(judge('192.168.1.1', gated)).toBe('allow');
    // 公网
    expect(judge('93.184.216.34', gated)).toBe('allow');

    expect(() => parseWebhookUrl('ftp://example.com/x')).toThrow(AutomationInvariantError);
    expect(() => parseWebhookUrl('file:///etc/passwd')).toThrow(AutomationInvariantError);
    expect(() => parseWebhookUrl('not a url')).toThrow(AutomationInvariantError);
    expect(parseWebhookUrl('http://example.com/x').hostname).toBe('example.com');
    expect(parseWebhookUrl('https://example.com/x').hostname).toBe('example.com');
  });

  it('★ 审计 P2-12：未启用访问口令时，私网放行**自动降级为拒绝**', () => {
    expect(judge('10.0.0.5', ungated)).toBe('deny-private');
    expect(judge('192.168.1.1', ungated)).toBe('deny-private');
    // 公网不受影响 —— 降级针对的是「向内网任意地址发 POST」这一条
    expect(judge('93.184.216.34', ungated)).toBe('allow');
  });

  it('开关 allowPrivateNetwork=false 时私网拒（即便有口令）', () => {
    expect(judge('10.0.0.5', noPrivate)).toBe('deny-private');
  });

  it('172.16/12 的边界：172.15 与 172.32 是公网，172.16–172.31 是私网', () => {
    expect(classifyAddress('172.15.0.1')).toBe('public');
    expect(classifyAddress('172.16.0.1')).toBe('private');
    expect(classifyAddress('172.31.255.255')).toBe('private');
    expect(classifyAddress('172.32.0.1')).toBe('public');
  });

  it('IPv4-mapped IPv6 按它映射的 v4 判 —— 换个写法绕不过去', () => {
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('loopback');
    expect(classifyAddress('::ffff:169.254.169.254')).toBe('link-local');
    expect(classifyAddress('::ffff:10.0.0.5')).toBe('private');
  });

  it('IPv6 链路本地 fe80::/10 与 ULA fc00::/7', () => {
    expect(classifyAddress('fe80::1')).toBe('link-local');
    expect(classifyAddress('fd00::1')).toBe('private');
    expect(classifyAddress('2606:4700::1111')).toBe('public');
    // 未指定地址等价于环回
    expect(classifyAddress('::')).toBe('loopback');
    expect(classifyAddress('0.0.0.0')).toBe('loopback');
  });
});

describe('WebhookTarget.matches —— triggerOn 归类（I-AUT-6 / T-AUT-30）', () => {
  it('★ T-AUT-30：triggerOn=failure + 成功 ⇒ 不发；+ timeout ⇒ **发**', () => {
    const t = WebhookTarget.create('https://example.com/hook', 'failure');
    expect(t.matches('success')).toBe(false);
    expect(t.matches('failed')).toBe(true);
    // ★ timeout 归入 failure 语义（03 §8.5）
    expect(t.matches('timeout')).toBe(true);
  });

  it('triggerOn=success 只匹配成功；all 全匹配', () => {
    const s = WebhookTarget.create('https://example.com/hook', 'success');
    expect(s.matches('success')).toBe(true);
    expect(s.matches('failed')).toBe(false);
    expect(s.matches('timeout')).toBe(false);

    const all = WebhookTarget.create('https://example.com/hook', 'all');
    expect(all.matches('success')).toBe(true);
    expect(all.matches('failed')).toBe(true);
    expect(all.matches('timeout')).toBe(true);
  });

  it('默认 triggerOn 是 failure（13 §2.7.1 的列默认值）', () => {
    expect(WebhookTarget.create('https://example.com/hook').triggerOn).toBe('failure');
  });

  it('构造即校验 scheme（I-AUT-6）', () => {
    expect(() => WebhookTarget.create('ftp://example.com/x')).toThrow(AutomationInvariantError);
    expect(() => WebhookTarget.create('javascript:alert(1)')).toThrow(AutomationInvariantError);
  });
});
