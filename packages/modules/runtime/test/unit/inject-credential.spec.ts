import { describe, it, expect } from 'vitest';
import type { RuntimeCredential, SandboxExecFn } from '@platform/contracts';
import { CodexAdapter } from '../../src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../src/infrastructure/adapters/claude-code/claude-code.adapter';

interface ExecCall {
  cmd: string[];
  opts?: { stdin?: string; env?: Record<string, string> };
}

function recordingExec(): { exec: SandboxExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: SandboxExecFn = async (cmd, opts) => {
    calls.push({ cmd, opts });
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  return { exec, calls };
}

describe('minimal-exposure injection (05 §4/§7 #3)', () => {
  it('codex account: access token goes on STDIN, never argv/env; authFile never injected', async () => {
    const codex = new CodexAdapter();
    const cred: RuntimeCredential = {
      runtimeId: 'codex',
      obtainedVia: 'oauth-device',
      issuedAt: '',
      accessToken: 'SECRET-ACCESS-TOKEN',
      authFile: '{"tokens":{"refresh_token":"SECRET-REFRESH"}}',
      credentialFiles: [],
      zeroize() {},
    };
    const { exec, calls } = recordingExec();
    await codex.injectCredential(cred, exec);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.cmd).toEqual(['codex', 'login', '--with-access-token']);
    // token NEVER in argv (防 /proc/<pid>/cmdline)
    expect(call.cmd.join(' ')).not.toContain('SECRET-ACCESS-TOKEN');
    // token on stdin only
    expect(call.opts?.stdin).toBe('SECRET-ACCESS-TOKEN');
    // the refresh_token-bearing authFile is NEVER passed to exec (P0-3)
    expect(JSON.stringify(calls)).not.toContain('SECRET-REFRESH');
    expect(JSON.stringify(calls)).not.toContain('CODEX_AUTH_JSON');
  });

  it('claude: env-form only — no exec, no argv, no file', async () => {
    const claude = new ClaudeCodeAdapter();
    const cred: RuntimeCredential = {
      runtimeId: 'claude-code',
      obtainedVia: 'setup-token',
      issuedAt: '',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-XYZ' },
      credentialFiles: [],
      zeroize() {},
    };
    const { exec, calls } = recordingExec();
    await claude.injectCredential(cred, exec);
    expect(calls).toHaveLength(0); // env is applied at sandbox START, no exec
  });

  it('codex api-key: env-form (OPENAI_API_KEY), no exec', async () => {
    const codex = new CodexAdapter();
    const cred = await codex.createCredentialFromSecret('api-key', 'sk-openai-1234567890');
    expect(cred.env).toEqual({ OPENAI_API_KEY: 'sk-openai-1234567890' });
    expect(cred.accessToken).toBeUndefined();
    const { exec, calls } = recordingExec();
    await codex.injectCredential(cred, exec);
    expect(calls).toHaveLength(0);
  });
});
