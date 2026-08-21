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
