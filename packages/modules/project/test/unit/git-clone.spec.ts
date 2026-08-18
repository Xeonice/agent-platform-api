import { describe, it, expect } from 'vitest';
import {
  classifyCloneError,
  sanitizeCloneMessage,
} from '../../src/infrastructure/git/error.classifier';
import { parseCloneProgress } from '../../src/infrastructure/git/progress.parser';
import { mergeAuthEnv } from '../../src/infrastructure/git/git-cloner';
import type { CloneRequest } from '../../src/domain/ports/git-cloner.port';

function req(overrides: Partial<CloneRequest>): CloneRequest {
  return {
    repoUrl: 'https://example.com/x.git',
    repoBranch: null,
    destPath: '/tmp/x',
    timeoutMs: 1000,
    signal: new AbortController().signal,
    onProgress: () => {},
    ...overrides,
  };
}

describe('mergeAuthEnv hermetic discipline (no-cred path)', () => {
  it('NO credential → still resets the credential helper chain (neutralize ambient osxkeychain)', () => {
    const env = mergeAuthEnv({}, req({}));
    // a public / no-credential clone must NOT consult an ambient/built-in helper
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe(''); // empty value = reset the helper list
  });

  it('NO gitSshCommand → injects a hermetic ssh (no ambient identity/config)', () => {
    const env = mergeAuthEnv({}, req({}));
    expect(env.GIT_SSH_COMMAND).toContain('-F /dev/null');
    expect(env.GIT_SSH_COMMAND).toContain('-o IdentitiesOnly=yes');
  });

  it('credentialed env (materializer already reset at index 0) is preserved, not doubled', () => {
    const authEnv = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://h.helper',
      GIT_CONFIG_VALUE_1: '!f...',
      GIT_TOKEN: 'secret',
    };
    const env = mergeAuthEnv({}, req({ env: authEnv }));
    expect(env.GIT_CONFIG_COUNT).toBe('2'); // untouched — no extra reset appended
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://h.helper');
  });

  it('platform gitSshCommand (from materializer) is preserved', () => {
    const env = mergeAuthEnv({}, req({ gitSshCommand: 'ssh -i /k -o Foo=bar' }));
    expect(env.GIT_SSH_COMMAND).toBe('ssh -i /k -o Foo=bar');
  });
});

describe('classifyCloneError (03 §7.5)', () => {
  it('permission is matched before network', () => {
    expect(classifyCloneError('fatal: Authentication failed for https://h/x')).toBe(
      'CLONE_FAILED_PERMISSION',
    );
    expect(classifyCloneError('remote: Repository not found.')).toBe('CLONE_FAILED_PERMISSION');
    expect(classifyCloneError('Permission denied (publickey).')).toBe('CLONE_FAILED_PERMISSION');
    // hermetic no-cred clone (GIT_TERMINAL_PROMPT=0) → git prints this, NOT "auth failed".
    expect(
      classifyCloneError('fatal: could not read Username for https://h: terminal prompts disabled'),
    ).toBe('CLONE_FAILED_PERMISSION');
    expect(classifyCloneError('fatal: unable to get password from user')).toBe(
      'CLONE_FAILED_PERMISSION',
    );
    expect(
      classifyCloneError('remote: HTTP Basic: Access denied\nfatal: Authentication failed'),
    ).toBe('CLONE_FAILED_PERMISSION');
  });
  it('disk full → DISK_INSUFFICIENT', () => {
    expect(classifyCloneError('error: write: No space left on device')).toBe('DISK_INSUFFICIENT');
    expect(classifyCloneError('fatal: ENOSPC something')).toBe('DISK_INSUFFICIENT');
  });
  it('everything else → NETWORK', () => {
    expect(classifyCloneError('fatal: unable to access: Could not resolve host: h')).toBe(
      'CLONE_FAILED_NETWORK',
    );
    expect(classifyCloneError('fatal: the remote end hung up unexpectedly')).toBe(
      'CLONE_FAILED_NETWORK',
    );
  });
});

describe('sanitizeCloneMessage', () => {
  it('strips URL userinfo and tokens', () => {
    const s = sanitizeCloneMessage(
      'fatal: unable to access https://user:secretpw@github.com/x.git ghp_ABCDEFGHIJKLMNOPQRSTUVWX',
    );
    expect(s).not.toContain('secretpw');
    expect(s).not.toContain('user:');
    expect(s).toContain('https://github.com/x.git');
    expect(s).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWX');
  });
  it('redacts query-string secrets', () => {
    const s = sanitizeCloneMessage(
      'unable to access https://h/x.git?token=abc123&password=hunter2&ref=main',
    );
    expect(s).not.toContain('abc123');
    expect(s).not.toContain('hunter2');
    expect(s).toContain('token=***');
    expect(s).toContain('password=***');
    expect(s).toContain('ref=main');
  });
});

describe('parseCloneProgress', () => {
  it('extracts percent + received bytes from a receiving line', () => {
    const p = parseCloneProgress('Receiving objects:  45% (450/1000), 5.00 MiB | 2.0 MiB/s\r');
    expect(p?.percent).toBe(45);
    expect(p?.receivedBytes).toBe(Math.round(5 * 1024 * 1024));
  });
  it('takes the latest of multiple CR-separated updates', () => {
    const p = parseCloneProgress('Receiving objects: 10% (1/10)\rReceiving objects: 90% (9/10)\r');
    expect(p?.percent).toBe(90);
  });
  it('returns null for non-receiving fragments', () => {
    expect(parseCloneProgress('remote: Counting objects: 100% (10/10), done.')).toBeNull();
  });
});
