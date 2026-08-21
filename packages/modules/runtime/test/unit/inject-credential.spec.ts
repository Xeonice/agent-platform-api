import { describe, it, expect } from 'vitest';
import { RUNTIME_REFRESH_TOKEN_PLACEHOLDER } from '@platform/shared-kernel';
import type { InjectableRuntimeCredential, SandboxExecFn } from '@platform/contracts';
import { CodexAdapter } from '../../src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../src/infrastructure/adapters/claude-code/claude-code.adapter';

interface ExecCall {
  cmd: string[];
  opts?: { stdin?: string; env?: Record<string, string> };
}

const SANDBOX_HOME = '/home/gem';

function recordingExec(homeAnswer: string = SANDBOX_HOME): {
  exec: SandboxExecFn;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: SandboxExecFn = async (cmd, opts) => {
    calls.push({ cmd, opts });
    const stdout = cmd.some((t) => t.includes('$HOME')) ? homeAnswer : '';
    return { stdout, stderr: '', exitCode: 0 };
  };
  return { exec, calls };
}

const REAL_REFRESH = 'REAL-REFRESH-TOKEN-must-never-be-injected';

/** The sanitized `auth.json` the adapter produced at credential BIRTH (05 §4.3 ②). */
const SANITIZED_AUTH_JSON = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: {
    access_token: 'ACCESS-TOKEN',
    refresh_token: RUNTIME_REFRESH_TOKEN_PLACEHOLDER,
    account_id: 'acct-1234',
  },
});

function codexFileCredential(containerPath = '~/.codex/auth.json'): InjectableRuntimeCredential {
  const cred: InjectableRuntimeCredential = {
    runtimeId: 'codex',
    obtainedVia: 'oauth-device',
    issuedAt: '',
    credentialFiles: [{ containerPath, content: SANITIZED_AUTH_JSON, mode: '0600' }],
    zeroize(): void {
      cred.credentialFiles = [];
    },
  };
  return cred;
}

/**
 * The DEFAULT codex injection form after the S5 技术验证 (05 §1★★ / §4.3): a `0600`
 * `auth.json` whose `refresh_token` value is the placeholder. The old default —
 * `codex login --with-access-token` on stdin — is now the optional, version-sensitive
 * second tier, and is exercised separately below.
 */
describe('minimal-exposure injection (05 §1★★ / §4/§7 #3)', () => {
  it('codex account: writes a 0600 auth.json at the sandbox-probed $HOME, content on stdin', async () => {
    const codex = new CodexAdapter();
    const { exec, calls } = recordingExec();
    await codex.injectCredential(codexFileCredential(), exec);

    expect(calls).toHaveLength(2);
    // ① $HOME is PROBED, not assumed (裁决 D-19) — no '/root', no compile-time constant.
    expect(calls[0].cmd.join(' ')).toContain('$HOME');
    // ② the file lands under the probed HOME, at the ~/-relative path.
    const write = calls[1];
    expect(write.cmd).toContain(`${SANDBOX_HOME}/.codex/auth.json`);
    expect(write.cmd).toContain('0600');
    expect(write.cmd.join(' ')).toContain('chmod');
    // ③ the CONTENT goes on stdin, verbatim — never into argv (/proc/<pid>/cmdline).
    expect(write.opts?.stdin).toBe(SANITIZED_AUTH_JSON);
    expect(write.cmd.join(' ')).not.toContain('access_token');
  });

  it('codex account: injection writes the file VERBATIM — it neither parses nor rewrites JSON', async () => {
    // 05 §4.3 ②: sanitization happened at BIRTH. If injection ever started re-parsing
    // and re-serializing, byte-for-byte equality would be the first thing to break.
    const codex = new CodexAdapter();
    const { exec, calls } = recordingExec();
    await codex.injectCredential(codexFileCredential(), exec);
    expect(calls[1].opts?.stdin).toBe(SANITIZED_AUTH_JSON);
  });

  it('codex account: the probed $HOME is used as-is (a different sandbox ⇒ a different path)', async () => {
    const codex = new CodexAdapter();
    const { exec, calls } = recordingExec('/root');
    await codex.injectCredential(codexFileCredential(), exec);
    expect(calls[1].cmd).toContain('/root/.codex/auth.json');
  });

  it('codex account: an ABSOLUTE containerPath is refused (裁决 D-19)', async () => {
    // An absolute path could only have been resolved before any sandbox existed — i.e.
    // against a guessed HOME, or by pinning this credential to one sandbox.
    const codex = new CodexAdapter();
    const { exec } = recordingExec();
    await expect(
      codex.injectCredential(codexFileCredential('/home/gem/.codex/auth.json'), exec),
    ).rejects.toMatchObject({ code: 'AUTH_REJECTED' });
  });

  it('codex account: an unresolvable $HOME fails loudly instead of writing to a guess', async () => {
    const codex = new CodexAdapter();
    const failingProbe: SandboxExecFn = async () => ({
      stdout: '',
      stderr: 'sh: not found',
      exitCode: 127,
    });
    await expect(codex.injectCredential(codexFileCredential(), failingProbe)).rejects.toMatchObject(
      {
        code: 'AUTH_REJECTED',
      },
    );
  });

  it('codex account (optional/version-sensitive tier): access token on STDIN, never argv', async () => {
    const codex = new CodexAdapter();
    const cred: InjectableRuntimeCredential = {
      runtimeId: 'codex',
      obtainedVia: 'oauth-device',
      issuedAt: '',
      accessToken: 'SECRET-ACCESS-TOKEN',
      credentialFiles: [], // no file ⇒ fall through to the second tier
      zeroize() {},
    };
    const { exec, calls } = recordingExec();
    await codex.injectCredential(cred, exec);

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toEqual(['codex', 'login', '--with-access-token']);
    expect(calls[0].cmd.join(' ')).not.toContain('SECRET-ACCESS-TOKEN');
    expect(calls[0].opts?.stdin).toBe('SECRET-ACCESS-TOKEN');
  });

  it('codex: the whole-auth.json env form is never used (P0-3)', async () => {
    const codex = new CodexAdapter();
    const { exec, calls } = recordingExec();
    await codex.injectCredential(codexFileCredential(), exec);
    expect(JSON.stringify(calls)).not.toContain('CODEX_AUTH_JSON');
    expect(JSON.stringify(calls)).not.toContain(REAL_REFRESH);
  });

  it('claude: env-form only — no exec, no argv, no file', async () => {
    const claude = new ClaudeCodeAdapter();
    const cred: InjectableRuntimeCredential = {
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
