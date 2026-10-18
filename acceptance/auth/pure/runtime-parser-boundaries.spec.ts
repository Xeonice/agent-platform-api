import { describe, expect, it } from 'vitest';
import {
  parseCodexAuthJson,
  sanitizeCodexAuthJson,
  parseCodexTaskEvents,
} from '../../../packages/modules/runtime/src/infrastructure/adapters/codex/codex.output-parser';
import { parseClaudeTaskEvents } from '../../../packages/modules/runtime/src/infrastructure/adapters/claude-code/claude-code.output-parser';

describe('runtime external JSON boundaries', () => {
  it.each([
    null,
    [],
    3,
    { tokens: [] },
    { tokens: { access_token: 1 } },
    { auth_mode: false },
    { OPENAI_API_KEY: {} },
  ])('rejects malformed credential structure without asserting its type: %j', (value) => {
    expect(() => parseCodexAuthJson(JSON.stringify(value))).toThrow();
  });
  it('retains valid credentials and provider extension fields', () => {
    const value = {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh',
        extension: 'retained',
      },
      extension: { provider: true },
    };
    expect(parseCodexAuthJson(JSON.stringify(value))).toEqual(value);
    const sanitized = JSON.parse(sanitizeCodexAuthJson(JSON.stringify(value)));
    expect(sanitized.extension).toEqual(value.extension);
    expect(sanitized.tokens.extension).toBe('retained');
    expect(sanitized.tokens.refresh_token).not.toBe('synthetic-refresh');
  });
  it('preserves absent optional metadata rather than rejecting a null as a malformed record', () => {
    const value = { auth_mode: null, OPENAI_API_KEY: null, tokens: null, last_refresh: null };
    expect(parseCodexAuthJson(JSON.stringify(value))).toEqual(value);
  });
  it('ignores non-record event payloads and malformed nested content', () => {
    const stream = 'null\n[]\n3\n{"type":"item.completed","item":[]}\n';
    expect(parseCodexTaskEvents(stream)).toEqual([]);
    expect(parseClaudeTaskEvents(stream + '{"type":"assistant","message":[]}')).toEqual([]);
  });
});
