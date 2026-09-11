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
    // `reason` 是**上屏文案**（走 `details[].message`），所以断言的是用户看得懂的那句话。
    expect(v.reason).toContain('sk-ant-oat01-');
  });

  it('rejects a fold-mangled token that kept a space (charset)', () => {
    const v = validateClaudeOauthToken('sk-ant-oat01-AAAA BBBB CCCC DDDD EEEE');
    expect(v.ok).toBe(false);
    // ⛔ `fold misjoin` 是终端折行的内部说法 —— 上屏文案里不许出现它。
    expect(v.reason).not.toMatch(/fold|misjoin/i);
    expect(v.reason).toContain('空格或换行');
  });

  it('每一条拒绝理由都是中文人话（它们要经 details[] 直接上屏）', () => {
    const verdicts = [
      validateClaudeOauthToken('nope'),
      validateClaudeOauthToken('sk-ant-oat01-AB'),
      validateClaudeOauthToken(`sk-ant-oat01-${'A'.repeat(600)}`),
      validateAnthropicApiKey('sk-openai-1234567890'),
      validateAnthropicApiKey('sk-ant-x'),
      validateOpenAiApiKey('nope'),
    ];
    for (const v of verdicts) {
      expect(v.ok).toBe(false);
      // 六条都必须有理由，且都得是中文（此前它们精确、但从不下发；下发之后还得看得懂）。
      expect(v.reason ?? '').not.toBe('');
      expect(v.reason ?? '').toMatch(/[\u4e00-\u9fa5]/);
    }
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
