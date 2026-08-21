import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parseClaudeAuthUrl,
  parseClaudeSetupToken,
} from '../../src/infrastructure/adapters/claude-code/claude-code.output-parser';
import {
  codexLoginSucceeded,
  parseCodexAuthJson,
  parseCodexDeviceChallenge,
} from '../../src/infrastructure/adapters/codex/codex.output-parser';
import { validateClaudeOauthToken } from '../../src/domain/services/token-format.validator';

/**
 * CLI golden-output replay (docs/backend/25 §2.3 / §4.2, 05 §6). The fixtures are
 * byte-exact recordings (OSC-8 escapes + pty fold newlines preserved) with SYNTHETIC
 * tokens (real prefix/length/form, low-entropy placeholder body). This is the ONLY
 * defense against "CLI upgrade silently breaks the parser".
 */
const FIX = resolve(__dirname, '../fixtures/cli-output');
const read = (p: string) => readFileSync(resolve(FIX, p), 'latin1');

describe('codex device-auth parser (golden)', () => {
  it('extracts the verification URL + device code from plain text (★2)', () => {
    const out = parseCodexDeviceChallenge(read('codex/v0.43.1/device-auth.txt'));
    expect(out).not.toBeNull();
    expect(out!.userCode).toBe('ABCD-2WXYZ');
    expect(out!.verificationUrl).toBe('https://auth.openai.com/codex/device');
  });

  it('detects login success + reads access_token from auth.json', () => {
    expect(codexLoginSucceeded(read('codex/v0.43.1/login-success.txt'))).toBe(true);
    const auth = parseCodexAuthJson(read('codex/v0.43.1/auth.json'));
    expect(auth.tokens?.access_token).toBe('SYNTHETIC-ACCESS-TOKEN-0001');
    expect(auth.tokens?.refresh_token).toBeDefined(); // platform keeps it; never injected
  });

  it('does NOT treat "not logged in" as success (P2: bare `logged in` substring bug)', () => {
    expect(codexLoginSucceeded(read('codex/v0.43.1/login-notloggedin.txt'))).toBe(false);
    // guard the exact failure phrasing too, independent of the fixture.
    expect(codexLoginSucceeded('You are not logged in.')).toBe(false);
  });
});

describe('claude setup-token parser (golden)', () => {
  it('recovers the FULL URL from the OSC-8 escape, not the truncated visible text (★1)', () => {
    const url = parseClaudeAuthUrl(read('claude-code/v1.8.0/setup-token.url.txt'));
    expect(url).toBe(
      'https://claude.ai/oauth/authorize?code=1&client=setup-token&state=abc123def456',
    );
    // a naive grep would have caught the truncated "…" visible link — assert it did not.
    expect(url).not.toContain('…');
  });

  it('rejoins the pty-folded token and it PASSES format validation', () => {
    const token = parseClaudeSetupToken(read('claude-code/v1.8.0/setup-token.url.txt'));
    expect(token).toBe('sk-ant-oat01-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ');
    expect(validateClaudeOauthToken(token!).ok).toBe(true);
  });

  it('fold MISJOIN negative: a mangled fold yields a token that FAILS validation (P1-4c)', () => {
    const token = parseClaudeSetupToken(read('claude-code/v1.8.0/setup-token.foldmisjoin.txt'));
    // block-join stops at the space-broken line → a truncated/short token,
    // which the PREFIX+LENGTH+CHARSET validator rejects rather than storing silently.
    expect(validateClaudeOauthToken(token ?? '').ok).toBe(false);
  });
});

describe('CLI-VERSION-MATRIX (25 §4.2): every fixture version dir is exercised', () => {
  it('has at least one fixture per runtime version directory', () => {
    for (const runtime of readdirSync(FIX)) {
      for (const version of readdirSync(resolve(FIX, runtime))) {
        const files = readdirSync(resolve(FIX, runtime, version));
        expect(files.length, `${runtime}/${version} must have fixtures`).toBeGreaterThan(0);
      }
    }
  });

  it('fixtures do NOT embed a real high-entropy token (secret-scanner, P2-4)', () => {
    // the synthetic bodies are low-entropy placeholders; assert no long mixed-case+digit run.
    const highEntropy = /sk-ant-oat01-[A-Za-z0-9_-]{40,}/;
    for (const runtime of readdirSync(FIX)) {
      for (const version of readdirSync(resolve(FIX, runtime))) {
        for (const f of readdirSync(resolve(FIX, runtime, version))) {
          const body = read(`${runtime}/${version}/${f}`);
          const m = highEntropy.exec(body);
          if (m) {
            // allowed only if it is our documented low-entropy placeholder (few distinct chars)
            const distinct = new Set(m[0].replace('sk-ant-oat01-', '').split('')).size;
            expect(distinct, `${f} looks like a real token`).toBeLessThan(16);
          }
        }
      }
    }
  });
});
