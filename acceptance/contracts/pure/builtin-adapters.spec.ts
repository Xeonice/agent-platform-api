import { runRuntimeAdapterContractTests } from '@platform/contracts/testkit';
import type { InjectableRuntimeCredential } from '@platform/contracts';
import { CodexAdapter } from '../../../packages/modules/runtime/src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../../packages/modules/runtime/src/infrastructure/adapters/claude-code/claude-code.adapter';

// Invented fixture material only. The public testkit records exec argv/stdin/env;
// it never starts an agent, reads a user credential file or contacts a vendor.
const CODEX_ACCESS = 'golden-codex-access-0123456789';
const CODEX_REFRESH = 'golden-codex-refresh-0123456789';
const CLAUDE_TOKEN = 'sk-ant-oat01-golden0123456789abcdef';
const CODEX_PLATFORM_AUTH = JSON.stringify({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: {
    id_token: 'golden-id-token',
    access_token: CODEX_ACCESS,
    refresh_token: CODEX_REFRESH,
    account_id: 'golden-account',
  },
  last_refresh: '2026-10-18T00:00:00Z',
});

function codexAccountCredential(): InjectableRuntimeCredential {
  // Use the real sanitizer output, so a broken birth-time sanitizer also fails
  // refresh-token isolation instead of testing a hand-written, already-clean file.
  const born = new CodexAdapter().refreshCapability.parseRefreshedAuth(CODEX_PLATFORM_AUTH);
  const credential: InjectableRuntimeCredential = {
    runtimeId: 'codex',
    obtainedVia: 'oauth-device',
    issuedAt: '',
    accessToken: born.accessToken,
    credentialFiles: born.credentialFiles ?? [],
    zeroize(): void {
      credential.accessToken = undefined;
      credential.credentialFiles = [];
    },
  };
  return credential;
}

function codexAccessOnlyCredential(): InjectableRuntimeCredential {
  const credential: InjectableRuntimeCredential = {
    runtimeId: 'codex',
    obtainedVia: 'oauth-device',
    issuedAt: '',
    accessToken: CODEX_ACCESS,
    credentialFiles: [],
    zeroize(): void {
      credential.accessToken = undefined;
    },
  };
  return credential;
}

function claudeAccountCredential(): InjectableRuntimeCredential {
  const credential: InjectableRuntimeCredential = {
    runtimeId: 'claude-code',
    obtainedVia: 'setup-token',
    issuedAt: '',
    env: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN },
    credentialFiles: [],
    zeroize(): void {
      credential.env = undefined;
    },
  };
  return credential;
}

runRuntimeAdapterContractTests('codex (built-in, real implementation)', () => new CodexAdapter(), {
  registryKey: 'codex',
  validApiKeySample: 'sk-golden0123456789abcdef',
  extraInvalidApiKeySamples: ['pk-golden0123456789abcdef', 'sk-short'],
  injectionCases: [
    {
      label: 'account with sanitized auth.json',
      credential: codexAccountCredential(),
      secrets: [CODEX_ACCESS, CODEX_REFRESH],
      platformOnly: {
        realRefreshToken: CODEX_REFRESH,
        platformAuthFile: CODEX_PLATFORM_AUTH,
      },
    },
    {
      label: 'optional access-token-only account',
      credential: codexAccessOnlyCredential(),
      secrets: [CODEX_ACCESS, CODEX_REFRESH],
      platformOnly: {
        realRefreshToken: CODEX_REFRESH,
        platformAuthFile: CODEX_PLATFORM_AUTH,
        expectsSanitizedAuthFile: false,
      },
    },
  ],
});

runRuntimeAdapterContractTests(
  'claude-code (built-in, real implementation)',
  () => new ClaudeCodeAdapter(),
  {
    registryKey: 'claude-code',
    validApiKeySample: 'sk-ant-golden0123456789abcdef',
    extraInvalidApiKeySamples: ['sk-golden0123456789abcdef', 'sk-ant-'],
    injectionCases: [
      {
        label: 'setup-token account',
        credential: claudeAccountCredential(),
        secrets: [CLAUDE_TOKEN],
      },
    ],
  },
);
