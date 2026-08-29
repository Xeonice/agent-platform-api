import { describe, it, expect } from 'vitest';
import { redactProxyConfig, redactProxyUrl } from '../../../src/platform/system/proxy-redaction';
import { redactLogLine } from '../../../src/platform/logging';
import { redactAuditDetail } from '../../../src/platform/audit/audit-redaction';

/**
 * 代理配置进审计之前的脱敏（`system.initialized` 的 detail，13 §2.8.2「脱敏在写入口」）。
 *
 * ⚠️ 这一组里最重要的是**倒数第二与最后两条**：它们证明既有的两道防线
 * （`log-redactor` 的密钥形状 + `audit-redaction` 的键名黑名单）**都接不住 URL userinfo**。
 * 少了那两条断言，这个文件读起来像是在给一段可有可无的封装做测试；有了它们，
 * 「为什么需要第三道」才是可验证的事实而不是一句说辞。
 */
describe('redactProxyUrl', () => {
  it('丢掉 userinfo，只留 scheme + host:port', () => {
    expect(redactProxyUrl('http://alice:s3cr3t@proxy.corp:3128')).toBe(
      'http://proxy.corp:3128（含凭证，已省略）',
    );
  });

  it('**用户名也不留** —— 企业环境里它往往就是域账号', () => {
    const out = redactProxyUrl('http://alice:s3cr3t@proxy.corp:3128')!;
    expect(out).not.toContain('alice');
    expect(out).not.toContain('s3cr3t');
  });

  it('没有凭证时原样保留 host（排障要看的就是「走的哪个代理」）', () => {
    expect(redactProxyUrl('http://proxy.corp:3128')).toBe('http://proxy.corp:3128');
  });

  it('没有 scheme 的写法照样处理 userinfo', () => {
    // `proxy.corp:3128` 这种写法能用，`new URL` 却解析不了 —— 解析不了不等于安全。
    expect(redactProxyUrl('alice:s3cr3t@proxy.corp:3128')).toBe(
      'proxy.corp:3128（含凭证，已省略）',
    );
  });

  it('丢掉 path / query —— 代理地址后面挂的东西不是审计要回答的问题', () => {
    expect(redactProxyUrl('http://proxy.corp:3128/pac?token=abc')).toBe('http://proxy.corp:3128');
  });

  it('空串与 undefined 都当作「没配」', () => {
    expect(redactProxyUrl('   ')).toBeUndefined();
    expect(redactProxyUrl(undefined)).toBeUndefined();
  });
});

describe('redactProxyConfig', () => {
  it('三项都脱敏，noProxy 原样（它带不了凭证，且对排障有直接价值）', () => {
    expect(
      redactProxyConfig({
        httpProxy: 'http://u:p@a.corp:3128',
        httpsProxy: 'https://u:p@b.corp:3129',
        noProxy: 'localhost,.internal',
      }),
    ).toEqual({
      httpProxy: 'http://a.corp:3128（含凭证，已省略）',
      httpsProxy: 'https://b.corp:3129（含凭证，已省略）',
      noProxy: 'localhost,.internal',
    });
  });

  it('没配代理时说 none，而不是一个空对象', () => {
    expect(redactProxyConfig(undefined)).toEqual({ proxy: 'none' });
    expect(redactProxyConfig({})).toEqual({ proxy: 'none' });
  });
});

describe('为什么必须有第三道防线（两道既有的都接不住）', () => {
  const raw = 'http://alice:s3cr3t@proxy.corp:3128';

  it('`log-redactor` 认的是密钥形状 —— URL userinfo 一条规则都不遮', () => {
    // ⚠️ 这不是在挑 log-redactor 的毛病：口令 `s3cr3t` 不长得像任何一种密钥
    //    （`sk-ant-…` / `ghp_…` / `Bearer …`），正则本来就抓不到它。
    expect(redactLogLine(raw)).toContain('s3cr3t');
  });

  it('审计的键名黑名单也接不住 —— `httpProxy` 拆开是 http/proxy，都不敏感', () => {
    const out = redactAuditDetail({ httpProxy: raw })!;
    expect(JSON.stringify(out)).toContain('s3cr3t');
  });

  it('⇒ 调用点必须先过 redactProxyConfig，之后再交给审计也遮不出问题', () => {
    const out = redactAuditDetail(redactProxyConfig({ httpProxy: raw }))!;
    expect(JSON.stringify(out)).not.toContain('s3cr3t');
    expect(JSON.stringify(out)).not.toContain('alice');
    // host 仍在 —— 脱敏不该把「走的哪个代理」这个排障信息一起删掉。
    expect(JSON.stringify(out)).toContain('proxy.corp:3128');
  });
});
