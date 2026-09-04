import { describe, it, expect } from 'vitest';
import { RUNTIME_REFRESH_TOKEN_PLACEHOLDER } from '@platform/shared-kernel';
import { sanitizeCodexAuthJson } from '../../src/infrastructure/adapters/codex/codex.output-parser';
import { CodexAdapter } from '../../src/infrastructure/adapters/codex/codex.adapter';

const REAL_REFRESH = 'REAL-REFRESH-9d3f8a2b-never-leaves-the-platform';

const RAW_AUTH_JSON = JSON.stringify({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: {
    id_token: 'id-token-value',
    access_token: 'access-token-value',
    refresh_token: REAL_REFRESH,
    account_id: 'acct-9999',
  },
  last_refresh: '2026-08-20T10:00:00Z',
  // a key the platform has never heard of — the CLI may add one at any time
  future_cli_field: { nested: 'keep me' },
});

interface ParsedAuthJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: Record<string, unknown>;
  last_refresh?: string;
  future_cli_field?: { nested?: string };
}

function parse(json: string): ParsedAuthJson {
  return JSON.parse(json) as ParsedAuthJson;
}

/**
 * BIRTH-TIME sanitization (05 §4.3 裁决 D-18 ②, 23 §8.2 I-CRD-9). Every site that MINTS
 * a codex credential — `completeAuth` and `parseRefreshedAuth` — must emit the two
 * halves side by side: a SANITIZED injectable file and the complete platform-only one.
 * These are the assertions that catch a sanitizer which stops replacing the token;
 * the testkit's RA-15/16/17 catch an injection path that mishandles the result.
 */
describe('codex birth-time sanitization (05 §4.3 ②)', () => {
  it('replaces the refresh_token VALUE and keeps every other byte of structure', () => {
    const sanitized = parse(sanitizeCodexAuthJson(RAW_AUTH_JSON));
    const original = parse(RAW_AUTH_JSON);

    expect(sanitized.tokens?.refresh_token).toBe(RUNTIME_REFRESH_TOKEN_PLACEHOLDER);
    // the FIELD survives: deleting it makes codex fail with `missing field
    // 'refresh_token'` (05 §1★★ 実測), so "just omit it" is not an acceptable fix.
    expect(Object.keys(sanitized.tokens ?? {})).toEqual(Object.keys(original.tokens ?? {}));
    // everything else is untouched, including keys the platform does not model
    expect(sanitized.tokens?.access_token).toBe('access-token-value');
    expect(sanitized.tokens?.id_token).toBe('id-token-value');
    expect(sanitized.tokens?.account_id).toBe('acct-9999');
    expect(sanitized.auth_mode).toBe('chatgpt');
    expect(sanitized.OPENAI_API_KEY).toBeNull();
    expect(sanitized.last_refresh).toBe('2026-08-20T10:00:00Z');
    expect(sanitized.future_cli_field?.nested).toBe('keep me');
  });

  it('the sanitized text contains no trace of the real refresh token', () => {
    expect(sanitizeCodexAuthJson(RAW_AUTH_JSON)).not.toContain(REAL_REFRESH);
  });

  it('a file with NO tokens object still gains a placeholder refresh_token field', () => {
    const sanitized = parse(sanitizeCodexAuthJson(JSON.stringify({ auth_mode: 'apikey' })));
    expect(sanitized.tokens?.refresh_token).toBe(RUNTIME_REFRESH_TOKEN_PLACEHOLDER);
  });

  it('parseRefreshedAuth (the THIRD birth site) emits the sanitized file too', () => {
    // A refresh mints a credential just as a login does. Returning only the access
    // token would silently leave every later injection with no file to write.
    const refreshed = new CodexAdapter().refreshCapability.parseRefreshedAuth(RAW_AUTH_JSON);
    expect(refreshed.accessToken).toBe('access-token-value');
    expect(refreshed.credentialFiles).toHaveLength(1);
    const file = refreshed.credentialFiles?.[0];
    expect(file?.containerPath).toBe('~/.codex/auth.json'); // ~/-relative (裁决 D-19)
    expect(file?.containerPath.startsWith('/')).toBe(false);
    expect(file?.mode).toBe('0600');
    expect(file?.content).not.toContain(REAL_REFRESH);
    expect(parse(file?.content ?? '{}').tokens?.refresh_token).toBe(
      RUNTIME_REFRESH_TOKEN_PLACEHOLDER,
    );
  });
});

/**
 * 消毒器面对**畸形输入**时的行为。
 *
 * ⚠️ 这一组补的是一个真空：上面四条喂的全是形状正确的 auth.json，于是
 * 「`parsed` 不是对象就抛」与「`tokens` 不是对象就重建」这两道闸**一次都没被走过**。
 * 它们不是防御性冗余 —— 消毒器的契约是「出去的这份文件里一定没有真 refresh_token」，
 * 而一个把非对象原样 `JSON.stringify` 回去、或者把字符串 `tokens` 展开成
 * `{0:'a',1:'b'}` 的实现，会让这条契约以最安静的方式失效。
 */
describe('codex 消毒器面对畸形 auth.json', () => {
  it('★ 顶层不是 JSON 对象 ⇒ 抛，而不是原样放行', () => {
    for (const notAnObject of ['null', '[]', '"a string"', '42', 'true']) {
      expect(() => sanitizeCodexAuthJson(notAnObject), notAnObject).toThrow(/not a JSON object/);
    }
    // 正向对照：一个合法对象照样过得去，所以上面的抛不是「消毒器整个坏了」
    expect(sanitizeCodexAuthJson('{}')).toContain(RUNTIME_REFRESH_TOKEN_PLACEHOLDER);
  });

  it('★ `tokens` 不是对象（null / 数组 / 字符串）⇒ 重建成只含占位符的对象', () => {
    for (const tokens of [null, ['REAL-A', 'REAL-B'], 'REAL-LOOKING-STRING', 42] as unknown[]) {
      const out = parse(sanitizeCodexAuthJson(JSON.stringify({ auth_mode: 'chatgpt', tokens })));
      // ⚠️ 展开一个字符串会得到 `{0:'R',1:'E',…}`；展开一个数组会得到一个带下标键的
      // 对象。两种都还是「一份 codex 读不懂、但里面可能带着原文」的文件。
      expect(out.tokens).toEqual({ refresh_token: RUNTIME_REFRESH_TOKEN_PLACEHOLDER });
      // 其余字段不受影响
      expect(out.auth_mode).toBe('chatgpt');
    }
    // 正向对照：合法的 tokens 对象里的其它字段一个都不能丢（与首条断言同源）
    const kept = parse(
      sanitizeCodexAuthJson(JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } })),
    );
    expect(kept.tokens).toEqual({
      access_token: 'a',
      refresh_token: RUNTIME_REFRESH_TOKEN_PLACEHOLDER,
    });
  });
});
