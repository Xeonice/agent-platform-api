import { describe, it, expect } from 'vitest';
import {
  REDACTED,
  probeArgvShape,
  redactAuditDetail,
  redactAuditText,
} from '../../../src/platform/audit/audit-redaction';

/**
 * 写入口脱敏（13 §2.8.2「脱敏在写入口」/ 05 §4 / P21-5 §10.5）。
 *
 * ⚠️ 这不是「以防万一」的测试。**明文一旦落库，导出、备份、DB 文件三条路都漏**，
 * 而这三条路上都没有第二道闸。
 */
describe('按值脱敏 —— 与运行日志同一套正则（13 §2.8.2）', () => {
  it('遮住 claude / openai / github 家族的密钥', () => {
    expect(redactAuditText('token=sk-ant-oat01-AAAABBBBCCCC')).not.toContain('AAAABBBBCCCC');
    expect(redactAuditText('ghp_abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redactAuditText('Authorization: Bearer zzzzzzzzzzzz')).not.toContain('zzzzzzzzzzzz');
  });
});

describe('按键名脱敏 —— 正则追不上「下一个格式的密钥」，键名可以', () => {
  it('token / secret / password / apiKey / authorization 一律整值替换', () => {
    const out = redactAuditDetail({
      accessToken: 'plain-value-1',
      db_password: 'plain-value-2',
      apiKey: 'plain-value-3',
      nested: { clientSecret: 'plain-value-4' },
    });
    expect(JSON.stringify(out)).not.toMatch(/plain-value/);
    expect(out?.accessToken).toBe(REDACTED);
  });

  /**
   * ⚠️ 这一条盯的是 04 §2.3★：agent 把 `env` 物化成 `export K=V` 拼进命令串、
   * 沙箱内 `ps` 全文可见。所以审计**不记 env 值** —— 键名黑名单是结构上的兜底，
   * 递进来了也落不进库。
   */
  it('env 整块不落库（04 §2.3★）', () => {
    const out = redactAuditDetail({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'oat-plaintext' } });
    expect(out?.env).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain('oat-plaintext');
  });
});

describe('argv 形状 —— 记形状不记内容（13 §2.8.2 对 sandbox.probe 的特别叮嘱）', () => {
  it('可执行名与旗标名留着，实参一律 <arg>', () => {
    expect(probeArgvShape(['claude', '--print', '/tmp/user-secret-path'])).toEqual([
      'claude',
      '--print',
      '<arg>',
    ]);
  });

  it('`--flag=value` 只留 flag 名', () => {
    expect(probeArgvShape(['codex', '--api-key=sk-live-xyz'])).toEqual([
      'codex',
      '--api-key=<value>',
    ]);
  });

  /**
   * ⚠️ **这一条是整份脱敏里最容易漏的。** `redactLogLine` 认的是**密钥的形状**；
   * 一个自建网关的 token、一个内网地址、一个用户自己起名的变量都不长得像密钥，
   * 正则一个都不会遮。命令串里那句 `export K=V` 因此只能靠 argv 形状挡住。
   */
  it('detail.argv 走形状规则 —— export K=V 不会原样落库', () => {
    const out = redactAuditDetail({
      argv: ['bash', '-lc', 'export MY_GATEWAY_TOKEN=totally-not-sk-shaped; claude --version'],
    });
    expect(JSON.stringify(out)).not.toContain('totally-not-sk-shaped');
    expect(out?.argv).toEqual(['bash', '-lc', '<arg>']);
  });

  it('detail.cmd 是字符串时同样按形状处理', () => {
    const out = redactAuditDetail({ cmd: 'claude --print my-private-prompt' });
    expect(out?.cmd).toBe('claude --print <arg>');
  });
});

describe('结构护栏', () => {
  it('不就地改调用方递进来的对象', () => {
    const input = { accessToken: 'keep-me-visible-to-the-caller' };
    redactAuditDetail(input);
    expect(input.accessToken).toBe('keep-me-visible-to-the-caller');
  });

  it('超长字符串被截断并标注（不是静默丢弃）', () => {
    const out = redactAuditText('x'.repeat(10_000));
    expect(out.length).toBeLessThan(10_000);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });
});
