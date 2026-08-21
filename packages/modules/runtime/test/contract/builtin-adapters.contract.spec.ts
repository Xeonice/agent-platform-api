import { runRuntimeAdapterContractTests } from '@platform/contracts/testkit';
import type { InjectableRuntimeCredential } from '@platform/contracts';
import { CodexAdapter } from '../../src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../src/infrastructure/adapters/claude-code/claude-code.adapter';

/**
 * The two BUILT-IN RuntimeAdapters run the same golden suite a third-party adapter
 * runs (docs/backend/04 §10 "无双重标准"). Every clause here is CLI-free and
 * network-free, so this is an unconditional `pnpm test:contract` check.
 *
 * The sentinels below are fake material invented for this file — they exist only so
 * RA-14 can prove the adapter never writes credential plaintext into argv (05 §4) and
 * RA-15/16/17 can prove a real `refresh_token` never reaches a sandbox at all (P0-3).
 */
const CODEX_ACCESS_SENTINEL = 'testkit-codex-access-0123456789';
const CODEX_REFRESH_SENTINEL = 'testkit-codex-refresh-0123456789';
const CLAUDE_TOKEN_SENTINEL = 'sk-ant-oat01-testkit0123456789abcdef';

/** A full `auth.json` shaped like the real one (05 §1 ★2), carrying the real token. */
const CODEX_PLATFORM_AUTH_FILE = JSON.stringify({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: {
    id_token: 'testkit-id-token',
    access_token: CODEX_ACCESS_SENTINEL,
    refresh_token: CODEX_REFRESH_SENTINEL,
    account_id: 'testkit-account-1234',
  },
  last_refresh: '2026-08-20T00:00:00Z',
});

/**
 * The credential as the VAULT would hold it after a login/refresh: the injectable
 * files are the adapter's OWN birth-time output, obtained here from the pure
 * `parseRefreshedAuth` (no CLI, no network). Deriving the fixture instead of
 * hand-writing a sanitized file matters — it means RA-16 also fails if the adapter's
 * sanitizer itself ever stops replacing the token, not merely if injection mishandles
 * an already-clean file.
 *
 * Note what CANNOT be expressed here: the real `refresh_token`. The injected type has
 * no `authFile` field (05 §4.3 裁决 D-18), so it travels as the testkit's out-of-band
 * `platformOnly` fixture instead — which is exactly the guarantee under test.
 */
function codexAccountCredential(): InjectableRuntimeCredential {
  const born = new CodexAdapter().refreshCapability.parseRefreshedAuth(CODEX_PLATFORM_AUTH_FILE);
  const cred: InjectableRuntimeCredential = {
    runtimeId: 'codex',
    obtainedVia: 'oauth-device',
    issuedAt: '',
    accessToken: born.accessToken,
    credentialFiles: born.credentialFiles ?? [],
    zeroize(): void {
      cred.accessToken = undefined;
      cred.credentialFiles = [];
    },
  };
  return cred;
}

/**
 * The OPTIONAL / version-sensitive second-tier form (05 §1★★ ②): access-token-only, no
 * file. Kept as its own case so the stdin branch is still contract-tested now that the
 * 0600 file is the default.
 */
function codexAccessTokenOnlyCredential(): InjectableRuntimeCredential {
  const cred: InjectableRuntimeCredential = {
    runtimeId: 'codex',
    obtainedVia: 'oauth-device',
    issuedAt: '',
    accessToken: CODEX_ACCESS_SENTINEL,
    credentialFiles: [],
    zeroize(): void {
      cred.accessToken = undefined;
    },
  };
  return cred;
}

function claudeAccountCredential(): InjectableRuntimeCredential {
  const cred: InjectableRuntimeCredential = {
    runtimeId: 'claude-code',
    obtainedVia: 'setup-token',
    issuedAt: '',
    env: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN_SENTINEL },
    credentialFiles: [],
    zeroize(): void {
      cred.env = undefined;
    },
  };
  return cred;
}

runRuntimeAdapterContractTests('codex (built-in, REAL implementation)', () => new CodexAdapter(), {
  registryKey: 'codex',
  validApiKeySample: 'sk-testkit0123456789abcdef',
  extraInvalidApiKeySamples: ['pk-testkit0123456789abcdef', 'sk-short'],
  injectionCases: [
    {
      label: 'codex account (0600 sanitized auth.json — the default form)',
      credential: codexAccountCredential(),
      secrets: [CODEX_ACCESS_SENTINEL, CODEX_REFRESH_SENTINEL],
      platformOnly: {
        realRefreshToken: CODEX_REFRESH_SENTINEL,
        platformAuthFile: CODEX_PLATFORM_AUTH_FILE,
      },
    },
    {
      label: 'codex account (access-token-only on stdin — optional/version-sensitive)',
      credential: codexAccessTokenOnlyCredential(),
      secrets: [CODEX_ACCESS_SENTINEL, CODEX_REFRESH_SENTINEL],
      platformOnly: {
        realRefreshToken: CODEX_REFRESH_SENTINEL,
        platformAuthFile: CODEX_PLATFORM_AUTH_FILE,
        // this form injects no auth file at all, so there is no placeholder to find
        expectsSanitizedAuthFile: false,
      },
    },
  ],
});

runRuntimeAdapterContractTests(
  'claude-code (built-in, REAL implementation)',
  () => new ClaudeCodeAdapter(),
  {
    registryKey: 'claude-code',
    validApiKeySample: 'sk-ant-testkit0123456789abcdef',
    extraInvalidApiKeySamples: ['sk-testkit0123456789abcdef', 'sk-ant-'],
    injectionCases: [
      {
        label: 'claude account (setup-token)',
        credential: claudeAccountCredential(),
        secrets: [CLAUDE_TOKEN_SENTINEL],
      },
    ],
  },
);
