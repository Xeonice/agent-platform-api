import { describe, expect, it } from 'vitest';
import {
  parseClaudeAuthUrl,
  parseClaudeSetupToken,
} from '../../../packages/modules/runtime/src/infrastructure/adapters/claude-code/claude-code.output-parser';
import {
  parseCodexDeviceChallenge,
  sanitizeCodexAuthJson,
} from '../../../packages/modules/runtime/src/infrastructure/adapters/codex/codex.output-parser';

describe('synthetic CLI challenge bytes and credential injection sanitization', () => {
  it('reads the OSC8 destination rather than the visibly truncated URL', () => {
    const url = 'https://claude.ai/oauth/authorize?client_id=fixture&state=synthetic';
    expect(
      parseClaudeAuthUrl(`\x1b]8;;${url}\x1b\\https://claude.ai/oauth/au…\x1b]8;;\x1b\\`),
    ).toBe(url);
    expect(parseClaudeAuthUrl('No authorization URL in this output')).toBeNull();
  });
  it('reassembles folded token bytes and stops before following instructions', () => {
    const head = 'sk-ant-oat01-' + 'F'.repeat(40);
    const tail = 'I'.repeat(40);
    expect(
      parseClaudeSetupToken(
        `\x1b[32m${head}\x1b[0m\r\n${tail}\r\nSave this token securely.\r\nWRONG_CONTINUATION`,
      ),
    ).toBe(head + tail);
    expect(parseClaudeSetupToken('No token')).toBeNull();
  });
  it('requires both a Codex device URL and its code', () => {
    expect(parseCodexDeviceChallenge('https://auth.openai.com/codex/device\nABCD-EFGHI')).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGHI',
    });
    expect(parseCodexDeviceChallenge('https://auth.openai.com/codex/device')).toBeNull();
  });
  it('refresh token is replaced before any injectable auth file is produced', () => {
    const refresh = 'synthetic-refresh-must-not-reach-task';
    const source = JSON.stringify({
      tokens: {
        access_token: 'synthetic-access',
        refresh_token: refresh,
        id_token: 'synthetic-id',
      },
      last_refresh: '2026-10-05T00:00:00Z',
    });
    const sanitized = sanitizeCodexAuthJson(source);
    expect(sanitized).not.toContain(refresh);
    expect(JSON.parse(sanitized).tokens.access_token).toBe('synthetic-access');
    expect(JSON.parse(sanitized).tokens.refresh_token).toBeTruthy();
  });
});
