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

/**
 * ★ THE `GIT_TRACE*` FAMILY — 03 §7.3 G，2026-08 从「四个字面量」改成前缀。
 *
 * The guard's own comment said it covered 「the GIT_TRACE* family」 while the list held
 * four names. The ones it MISSED are the dangerous half: `GIT_TRACE2_ENV_VARS` prints
 * the VALUES of the env vars you name — point it at `GIT_TOKEN` and the PAT is written
 * into the trace verbatim — and `GIT_TRACE2_REDACT=0` switches off git's redaction of
 * the `Authorization:` header, the one thing keeping a curl trace from spelling out the
 * token. Both survived a guard that claimed to strip the family.
 *
 * MUTATION: delete the `GIT_TRACE_PREFIX.test(upper)` line and this goes red on the
 * TRACE2 names while the four legacy literals stay green — which is precisely the shape
 * of the hole, and precisely what a literal list cannot tell you.
 */
const TRACE_FAMILY = [
  // the four the old literal list had…
  'GIT_TRACE',
  'GIT_TRACE_CURL',
  'GIT_TRACE_PACKET',
  // …and the generation it never heard of.
  'GIT_TRACE2',
  'GIT_TRACE2_EVENT',
  'GIT_TRACE2_PERF',
  'GIT_TRACE2_ENV_VARS', // dumps named env VALUES into the trace
  'GIT_TRACE2_REDACT', // =0 disables Authorization redaction
  'GIT_TRACE_REDACT', // =0 same, gen-1
  'GIT_TRACE_SETUP',
  'GIT_TRACE_PERFORMANCE',
  'GIT_TRACE_PACK_ACCESS',
  'GIT_TRACE_SHALLOW',
  'GIT_TRACE_REFS',
];

function withTraceEnvSet(run: () => void): void {
  const saved = new Map([...TRACE_FAMILY, 'GIT_CURL_VERBOSE'].map((k) => [k, process.env[k]]));
  for (const k of TRACE_FAMILY) process.env[k] = '1';
  process.env.GIT_TRACE2_ENV_VARS = 'GIT_TOKEN';
  process.env.GIT_TRACE2_REDACT = '0';
  process.env.GIT_CURL_VERBOSE = '1';
  try {
    run();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('cleanGitEnv strips the whole GIT_TRACE* family, not a remembered list (03 §7.3 G)', () => {
  it('no trace variable — including the TRACE2 generation — reaches the git child', () => {
    withTraceEnvSet(() => {
      const env = cleanGitEnv();
      for (const k of TRACE_FAMILY) {
        expect(env[k], `${k} would let the clone print its own credentials`).toBeUndefined();
      }
      // the one family member that is NOT `GIT_TRACE`-prefixed still needs its literal.
      expect(env.GIT_CURL_VERBOSE).toBeUndefined();
      // still a deny-list: ordinary inherited vars are untouched.
      expect(env.PATH).toBe(process.env.PATH);
    });
  });

  it('a name that merely CONTAINS the prefix elsewhere is not collateral damage', () => {
    const saved = process.env.MY_GIT_TRACE_HELPER;
    process.env.MY_GIT_TRACE_HELPER = 'keep-me';
    try {
      expect(cleanGitEnv().MY_GIT_TRACE_HELPER).toBe('keep-me');
    } finally {
      if (saved === undefined) delete process.env.MY_GIT_TRACE_HELPER;
      else process.env.MY_GIT_TRACE_HELPER = saved;
    }
  });
});

/**
 * ★ `objectsTotal` 是**本阶段的**分母 —— 这条把一句注释变成可执行的事实。
 *
 * 从 2026-08 起有三个文件（api 的 port、web 的 types、web 的 ws-protocol）加上两份文档
 * 写着「`objectsTotal` 是 git 唯一在事前就知道的总量」。前半句对（`Enumerating objects`
 * 确实开头就报），后半句不对，而且**没有任何东西在检验它**——注释不会红。
 *
 * 一句错话跟着一个正确的修复传播到五处，是 LIVE-RUN-FINDINGS 共性 2 的又一形态：
 * 修 bug 时顺手写下的解释，本身从来没被验证过。
 *
 * 这条用**同一次 clone 的真实 stderr 片段**证明分母会变，因此下一个想做「整体进度」的人
 * 会先在这里撞上事实，而不是在生产里撞上一个跳变的数字。
 */
describe('objectsTotal 是 per-stage 分母，不是全程分母', () => {
  it('同一次 clone 里，各阶段报出的 total 是不同的量', () => {
    // 真实 git 输出的形状：远端对象 26348 → delta 12000 → 工作树文件 3000。
    const receiving = parseCloneProgress('Receiving objects:  50% (13174/26348), 1.20 MiB');
    const resolving = parseCloneProgress('Resolving deltas:  50% (6000/12000)');
    const checkout = parseCloneProgress('Updating files:  50% (1500/3000)');

    expect(receiving?.objectsTotal).toBe(26348); // 对象数
    expect(resolving?.objectsTotal).toBe(12000); // delta 数 —— 不是对象数
    expect(checkout?.objectsTotal).toBe(3000); // 文件数 —— 连量纲都不是一个

    // 把它当跨阶段稳定的分母，用户会看到 26348 → 12000 → 3000 一路跳。
    const totals = [receiving, resolving, checkout].map((p) => p?.objectsTotal);
    expect(new Set(totals).size).toBe(3);
  });

  it('压缩阶段的 total 也只算需压缩的对象，同样小于对象总数', () => {
    const enumerating = parseCloneProgress('remote: Enumerating objects: 26348, done.');
    const compressing = parseCloneProgress('remote: Compressing objects:  50% (4000/8000)');
    expect(enumerating?.objectsTotal).toBe(26348);
    expect(compressing?.objectsTotal).toBe(8000);
    expect(compressing?.objectsTotal).toBeLessThan(enumerating?.objectsTotal ?? 0);
  });

  it('每一帧都自带 stage —— 这正是这对数唯一可被正确解读的原因', () => {
    // `buildDetailLabel` 渲染成「接收对象 · 13,174/26,348」：阶段名限定了分母的含义。
    // 少了 stage，同一对数字就无从解释 —— 所以 stage 不是装饰，是这对数的单位。
    for (const line of [
      'Receiving objects:  50% (13174/26348)',
      'Resolving deltas:  50% (6000/12000)',
      'Updating files:  50% (1500/3000)',
    ]) {
      expect(parseCloneProgress(line)?.stage, line).toBeDefined();
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
  /**
   * ⚠️ 这一组断言全部用 `toBe` 而不是 `not.toContain(secret)`。
   * 「秘密不在结果里」在**脱敏把整段都吃掉**时同样为真（29 §3.5.2 的假绿形状二）——
   * 把 `'***'` 换成 `''`、把 `[^\s&]+` 缩成 `[^\s&]`，旧断言全都照绿。
   * 逐字比对同时锁住两件事：秘密没了，**且**周围的诊断信息还在。
   */
  it('strips URL userinfo and tokens', () => {
    const s = sanitizeCloneMessage(
      'fatal: unable to access https://user:secretpw@github.com/x.git ghp_ABCDEFGHIJKLMNOPQRSTUVWX',
    );
    expect(s).not.toContain('secretpw');
    expect(s).not.toContain('user:');
    expect(s).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWX');
    // ⭐ 正向证据：token 位置留下的是 `***`，不是被整段删掉。
    expect(s).toBe('fatal: unable to access https://github.com/x.git ***');
  });

  it('⭐ URL 就在消息开头时也要脱敏 —— 前面没有任何字符可以垫', () => {
    // git 有的行第一个字符就是 URL（`https://…: Permission denied`）。
    // 把 `[a-z]` 写成 `[^a-z]` 的实现在「URL 前面有个空格」时看不出区别，
    // 只有这一条能把它逼出来。
    const s = sanitizeCloneMessage('https://user:secretpw@github.com/x.git: Permission denied');
    expect(s).toBe('https://github.com/x.git: Permission denied');
  });

  it('⭐ 只有 token、没有密码的 userinfo 同样抹掉（`https://<PAT>@host` 是最常见写法）', () => {
    // `(?::…)?` 那个 `?` 一旦丢了，这种写法就一个字符都不脱敏。
    const s = sanitizeCloneMessage('fatal: unable to access https://s3cr3t-pat@github.com/x.git');
    expect(s).toBe('fatal: unable to access https://github.com/x.git');
  });

  it('⭐⭐ `Authorization:` 整行被抹掉 —— curl trace 会把 PAT 原样打出来', () => {
    // 03 §7.3 G：`GIT_CURL_VERBOSE=1` 的 stderr 里有
    // `Authorization: Basic base64(x-access-token:PAT)`，base64 不匹配任何 token 规则，
    // 只有这条整行规则拦得住它。
    const s = sanitizeCloneMessage(
      '> GET /x.git/info/refs HTTP/1.1\nAuthorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX1NFQ1JFVA==\n< HTTP/1.1 401',
    );
    expect(s).not.toContain('eC1hY2Nlc3MtdG9rZW46Z2hwX1NFQ1JFVA==');
    // ⭐ 正向证据：这一行确实被替换过（不是"整段没了"），且**只**吃掉这一行。
    expect(s).toBe('> GET /x.git/info/refs HTTP/1.1 Authorization: *** < HTTP/1.1 401');
  });

  it('⭐⭐ `authorization:` 冒号后没空格 / 多个空格的写法一样抹掉', () => {
    // `\s*` 被改成 `\s` 或 `\s+`（都要求至少一个空白）时，这两种写法就漏出去了。
    expect(sanitizeCloneMessage('authorization:Bearer s3cr3t-token-value')).toBe(
      'Authorization: ***',
    );
    expect(sanitizeCloneMessage('Authorization:   Basic s3cr3t-token-value')).toBe(
      'Authorization: ***',
    );
  });

  it('⭐ `github_pat_` 新式 PAT 与 `x-access-token:` 头都在名单里', () => {
    // 这两条规则此前一个字符都没被测过 —— 删掉它们、或把 `{20,}` 写成 `{1}`，全绿。
    expect(
      sanitizeCloneMessage('remote: token github_pat_11ABCDEFG0abcdefghijklmnop rejected'),
    ).toBe('remote: token *** rejected');
    expect(sanitizeCloneMessage('fatal: could not read x-access-token:ghs_SUPERSECRET from')).toBe(
      'fatal: could not read x-access-token:*** from',
    );
  });

  it('redacts query-string secrets', () => {
    const s = sanitizeCloneMessage(
      'unable to access https://h/x.git?token=abc123&password=hunter2&ref=main',
    );
    expect(s).not.toContain('abc123');
    expect(s).not.toContain('hunter2');
    // ⭐ `[^\s&]+` 缩成 `[^\s&]` 时只吃掉第一个字符（`token=***bc123`），
    //   而 `not.toContain('abc123')` 与 `toContain('token=***')` **两条都照绿**。
    expect(s).toBe('unable to access https://h/x.git?token=***&password=***&ref=main');
  });

  it('⭐ 尾部整形：空白折成一个空格、首尾去空白、截断到 500', () => {
    // 落库/上报的是这个结果：不折行会把多行 stderr 原样塞进一列，不截断则一次失败
    // 能写进几十 KB。三个动作各自都有变异体在活着。
    expect(sanitizeCloneMessage('  fatal:\n\tremote  hung up  ')).toBe('fatal: remote hung up');
    const long = sanitizeCloneMessage(`fatal: ${'x'.repeat(600)}`);
    expect(long).toHaveLength(500);
    expect(long.startsWith('fatal: xxx')).toBe(true);
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
