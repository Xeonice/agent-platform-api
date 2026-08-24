import { describe, it, expect } from 'vitest';
import {
  classifyCloneError,
  sanitizeCloneMessage,
} from '../../src/infrastructure/git/error.classifier';
import { parseCloneProgress } from '../../src/infrastructure/git/progress.parser';
import { cleanGitEnv, mergeAuthEnv } from '../../src/infrastructure/git/git-env';
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

describe('cleanGitEnv drops ambient repo-location overrides (03 §7.2★)', () => {
  // `baseDir` does NOT decide which repository git acts on: GIT_DIR & friends outrank
  // it. That was harmless while the only command was `clone` into a fresh path; it
  // stopped being harmless when `listBranches` / `fetchAll` started running INSIDE an
  // existing baseline — an inherited GIT_DIR would list another repo's branches (a
  // picker offering names the baseline does not have) and fetch into it.
  //
  // MUTATION: remove any of these names from `GUARDED_ENV` and this goes red.
  const HIJACKERS = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_CEILING_DIRECTORIES',
  ];

  it('none of them survives into a platform git child', () => {
    const saved = new Map(HIJACKERS.map((k) => [k, process.env[k]]));
    for (const k of HIJACKERS) process.env[k] = '/somewhere/else/.git';
    try {
      const env = cleanGitEnv();
      for (const k of HIJACKERS) expect(env[k], `${k} leaked into the git child`).toBeUndefined();
      // …and the guard is a DENY-LIST, not a whitelist: ordinary inherited vars stay,
      // because a clone still needs PATH/HOME and the proxy settings (03 §7.3).
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
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
  it('extracts every field a receiving line carries', () => {
    const p = parseCloneProgress('Receiving objects:  45% (450/1000), 5.00 MiB | 2.0 MiB/s\r');
    expect(p?.stage).toBe('receiving');
    expect(p?.percent).toBe(45);
    expect(p?.receivedBytes).toBe(Math.round(5 * 1024 * 1024));
    // 这两对以前被丢掉：objects 在非捕获组里，速率根本没匹配。
    expect(p?.objectsDone).toBe(450);
    expect(p?.objectsTotal).toBe(1000);
    expect(p?.bytesPerSecond).toBe(Math.round(2 * 1024 * 1024));
  });

  it('takes the latest of multiple CR-separated updates', () => {
    const p = parseCloneProgress('Receiving objects: 10% (1/10)\rReceiving objects: 90% (9/10)\r');
    expect(p?.percent).toBe(90);
    expect(p?.objectsDone).toBe(9);
  });

  it('a receiving line without the size suffix still yields objects (git omits it early on)', () => {
    // 实测第一帧就是这个样子：`Receiving objects:   0% (1/26348)`，没有体积也没有速率。
    const p = parseCloneProgress('Receiving objects:   0% (1/26348)\r');
    expect(p?.objectsTotal).toBe(26348);
    expect(p?.receivedBytes).toBeUndefined();
    expect(p?.bytesPerSecond).toBeUndefined();
  });

  it('covers the pre-receiving stages — that window used to emit NOTHING', () => {
    // 实测 flask：receiving 开始前有 3.4s 只有这些行，慢远端上会长得多。
    // 旧解析器对它们一律返回 null ⇒ UI 只有一条脉冲条，一个数都没有。
    const enu = parseCloneProgress('remote: Enumerating objects: 26348, done.');
    expect(enu?.stage).toBe('enumerating');
    expect(enu?.objectsTotal).toBe(26348);
    expect(enu?.percent).toBeUndefined(); // 这一行 git 不给百分比，只给总数

    expect(parseCloneProgress('remote: Counting objects:  30% (3/10)')?.stage).toBe('counting');
    expect(parseCloneProgress('remote: Compressing objects: 50% (5/10)')?.stage).toBe(
      'compressing',
    );
    expect(parseCloneProgress('Resolving deltas:  70% (7/10)')?.stage).toBe('resolving');
    expect(parseCloneProgress('Updating files:  80% (8/10)')?.stage).toBe('checkout');
  });

  it('returns null only for fragments that really carry no stage', () => {
    expect(parseCloneProgress("Cloning into 'x'...")).toBeNull();
    expect(parseCloneProgress('remote: Total 26348 (delta 49), reused 32')).toBeNull();
  });
});
