import { runRuntimeAdapterContractTests } from '@platform/contracts/testkit';
import type { RuntimeCredential } from '@platform/contracts';
import { CodexAdapter } from '../../src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../src/infrastructure/adapters/claude-code/claude-code.adapter';

/**
 * The two BUILT-IN RuntimeAdapters run the same golden suite a third-party adapter
 * runs (docs/backend/04 §10 "无双重标准"). Every clause here is CLI-free and
 * network-free, so this is an unconditional `pnpm test:contract` check.
 *
 * The sentinels below are fake material invented for this file — they exist only so
 * RA-14 can prove the adapter never writes credential plaintext into argv (05 §4).
 */
const CODEX_ACCESS_SENTINEL = 'testkit-codex-access-0123456789';
const CODEX_REFRESH_SENTINEL = 'testkit-codex-refresh-0123456789';
const CLAUDE_TOKEN_SENTINEL = 'sk-ant-oat01-testkit0123456789abcdef';

function codexAccountCredential(): RuntimeCredential {
  const cred: RuntimeCredential = {
    runtimeId: 'codex',
    obtainedVia: 'oauth-device',
    issuedAt: '',
    accessToken: CODEX_ACCESS_SENTINEL,
    // the refresh-token-bearing file is PLATFORM-ONLY and must never reach a sandbox
    authFile: JSON.stringify({ tokens: { refresh_token: CODEX_REFRESH_SENTINEL } }),
    credentialFiles: [],
    zeroize(): void {
      cred.accessToken = undefined;
      cred.authFile = undefined;
    },
  };
  return cred;
}

function claudeAccountCredential(): RuntimeCredential {
  const cred: RuntimeCredential = {
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
      label: 'codex account (oauth-device access token)',
      credential: codexAccountCredential(),
      secrets: [CODEX_ACCESS_SENTINEL, CODEX_REFRESH_SENTINEL],
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
