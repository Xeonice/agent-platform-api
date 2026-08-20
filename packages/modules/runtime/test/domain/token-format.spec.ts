import { describe, it, expect } from 'vitest';
import {
  validateAnthropicApiKey,
  validateClaudeOauthToken,
  validateOpenAiApiKey,
} from '../../src/domain/services/token-format.validator';

describe('token format validator (05 §3 P1-4c)', () => {
  it('accepts a well-formed setup-token', () => {
    expect(validateClaudeOauthToken('sk-ant-oat01-AAAABBBBCCCCDDDDEEEEFFFF').ok).toBe(true);
  });

  it('rejects a token without the sk-ant-oat01- prefix', () => {
    const v = validateClaudeOauthToken('sk-ant-XXXXYYYYZZZZ0000');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/prefix/);
  });

  it('rejects a fold-mangled token that kept a space (charset)', () => {
    expect(validateClaudeOauthToken('sk-ant-oat01-AAAA BBBB CCCC DDDD EEEE').ok).toBe(false);
  });

  it('rejects a truncated token (too short)', () => {
    expect(validateClaudeOauthToken('sk-ant-oat01-AB').ok).toBe(false);
  });

  it('validates OpenAI vs Anthropic api keys by prefix', () => {
    expect(validateOpenAiApiKey('sk-proj-abcdefgh12345678').ok).toBe(true);
    expect(validateAnthropicApiKey('sk-ant-api03-abcdefgh1234').ok).toBe(true);
    expect(validateOpenAiApiKey('nope').ok).toBe(false);
    expect(validateAnthropicApiKey('sk-openai-1234567890').ok).toBe(false);
  });
});
