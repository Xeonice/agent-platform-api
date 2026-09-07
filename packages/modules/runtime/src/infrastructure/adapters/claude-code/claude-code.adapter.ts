import { Injectable } from '@nestjs/common';
import type {
  ApiKeyFormatVerdict,
  AuthChallenge,
  AuthCompletionInput,
  AuthSessionContext,
  InjectableRuntimeCredential,
  RuntimeAdapter,
  RuntimeAuthMethod,
  RuntimeCredential,
  RuntimeEvent,
  RuntimeInstallPlan,
  RuntimeStartupSpec,
  RuntimeTaskSpec,
  ResolvedImageSpec,
  SandboxCommand,
  SandboxExecFn,
} from '@platform/contracts';
import {
  imagePreinstalls,
  npmInstallPlan,
  probeOnPath,
  runInstallCommands,
} from '../install-plan.util';
import {
  validateAnthropicApiKey,
  validateClaudeOauthToken,
} from '../../../domain/services/token-format.validator';
import { AdapterAuthError } from '../../../domain/errors/adapter-auth.error';
import { readUntil } from '../pty-reader.util';
import {
  parseClaudeAuthUrl,
  parseClaudeSetupToken,
  parseClaudeTaskEvents,
} from './claude-code.output-parser';
import { assertSessionRef } from '../session-ref.util';
import { probeSandboxHome, SEED_WRITE_TIMEOUT_MS } from '../home-probe.util';

/**
 * ⚠️ **60s → 120s（2026-08-26，同 `PROBE_TIMEOUT_MS` 的依据）。** 这一步要在 PTY 里
 * 起一次 CLI 再等它吐出授权 URL，而 CLI 在微 VM 里**光启动就实测 18.6 秒**（docker
 * 里 44ms）。60s 里有三分之一被启动吃掉，剩下的留给 CLI 自己联网换 URL——太紧，
 * 且它超时的表现是「登录向导毫无征兆地失败」。放宽只影响失败路径的等待时长。
 */
const BEGIN_TIMEOUT_MS = 120_000;
const COMPLETE_TIMEOUT_MS = 5 * 60_000;

const CLAUDE_BINARY = 'claude';
/**
 * Claude has NO bwrap — it ships a permission/approval model instead, and its own
 * help text says `--dangerously-skip-permissions` is "recommended only for sandboxes
 * with no internet access", i.e. it already assumes an EXTERNAL sandbox. That is
 * exactly our situation (04 §3 ★2). Note how little this has in common with codex's
 * `-s danger-full-access`: the shapes do not generalise, which is precisely why this
 * lives per-adapter and never in platform code.
 */
const PERMISSIONS_OFF_ARGS = ['--dangerously-skip-permissions'];
/**
 * **「这确实是一个刻意的沙箱」的声明** —— 少了它，agent 在我们的沙箱里根本起不来。
 *
 * ── 它修的是什么（2026-09-07 真机）────────────────────────────────────────────
 * 沙箱里是 root（两档镜像都没有 `USER`，boxlite 的提示符就是 `root@boxlite:/workspace#`），
 * 而 claude 拒绝 root + `--dangerously-skip-permissions`：
 *
 *     --dangerously-skip-permissions cannot be used with root/sudo privileges
 *     [platform] agent session ended (exit 1); you now have a shell
 *
 * ⚠️ **它拒的不是 root，是「root 而且不在刻意的沙箱里」** —— 从 2.1.261 的二进制里挖出的
 * 判据一字不差（那个函数干脆就叫 `isRootOutsideDeliberateSandbox`）：
 *
 *     process.getuid() === 0 && process.env.IS_SANDBOX !== '1' && !CLAUDE_CODE_BUBBLEWRAP
 *
 * ⇒ `IS_SANDBOX=1` 是官方留的那个声明口，而我们**确实**满足它：agent 跑在 boxlite 微 VM
 * 或 aio 容器里，与宿主隔离。这是**如实声明，不是绕过检查**。
 *
 * ⛔ 别改用「在镜像里造个非 root 用户」来躲开：那会连带动到工作区属主、凭证文件权限、
 * 以及两档镜像的构建 —— 为了一个环境变量能表达清楚的事实，去改整条运行形态。
 */
const DELIBERATE_SANDBOX_ENV = { IS_SANDBOX: '1' } as const;
/**
 * claude 的交互路径上有**四道**需要按键的闸门(实测 claude-code 2.1.241),平台一道
 * 都没处理 —— agent 会停在第一道上,界面上只是一个不动的终端:
 *
 *   ① 主题选择器  ② 登录方式选择  ③ 文件夹信任  ④ Bypass Permissions 警告
 *
 * ⚠️ 实测澄清的三件事:
 *   · ①② **不是凭证门控**。带真 token(`CLAUDE_CODE_OAUTH_TOKEN`)照样先弹主题、
 *     再问登录方式——onboarding 与"是否已鉴权"是两回事;
 *   · **无头路径完全不受影响**。同一个 token 走 `--print` 直接出结果,一道闸门都没有。
 *     所以这四道只挡交互终端;
 *   · `--allow-dangerously-skip-permissions` **不能**预先接受 ④(它的语义是"允许启用
 *     这个模式",不是"我已接受警告"),`--settings '{"theme":…}'` 也压不住 ①。
 *
 * 四道全由 `~/.claude.json` 里的三个键清掉(逐个从二进制 strings 里挖出来、逐个实测):
 * ①② ← `hasCompletedOnboarding`，③ ← `projects["<workdir>"].hasTrustDialogAccepted`
 *（按路径记,与 codex 的 `[projects."<dir>"]` 同构）,④ ← `bypassPermissionsModeAccepted`。
 * `~/.claude/settings.json`(主题)**不需要**——实测只写这一个文件就够。
 */
const CLAUDE_CONFIG_PATH = '~/.claude.json';
const claudeSeedJson = (workdir: string): string =>
  `${JSON.stringify(
    {
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      projects: { [workdir]: { hasTrustDialogAccepted: true } },
    },
    null,
    2,
  )}\n`;
/**
 * **只在文件不存在时写**。理由:
 *   · 镜像不预置这个文件(实测),所以全新容器上这一步必然生效;
 *   · 文件已存在 ⇒ 要么是上一次 provision 落的(键已在),要么是 claude 自己写的
 *     (那说明它已经跑过、状态更全)。两种情况都不该覆盖 —— 那会把 claude 攒的
 *     会话/缓存状态抹掉。
 * 无论走哪条都把 stdin 读干净,否则写端拿 EPIPE。
 */
const SEED_CLAUDE_SCRIPT = [
  'set -e',
  'f="$1"',
  // ⚠️ 判据是**这个 workdir 的信任项在不在**,不是"文件在不在"。
  //
  // 第一版写的是 `if [ -f "$f" ]; then …skip`,于是只要 `~/.claude.json` 存在(上一轮
  // provision 写的、或 claude 自己写的)就整体跳过 —— **不检查这次传进来的 workdir
  // 对应的那一项是否真的在里面**。今天不触发的唯一原因是 `SANDBOX_WORKSPACE_MOUNT`
  // 全仓硬编码成 `/workspace`,workdir 事实上从没变过;而 `RuntimeStartupSpec.workdir`
  // 这个字段的存在本身就说明契约预期它可变。一旦支持按项目自定义 workdir,
  // "文件在、但里面是旧 workdir 那份"的沙箱会**静默**复现这个钩子要修的
  // "卡在交互提示、界面上一个不动的终端",而且连 WARN 都不会有(脚本判定"跳过"
  // 是正常退出)。改成与 codex 侧同构的内容匹配。
  'if [ -f "$f" ] && grep -qF "$2" "$f"; then cat >/dev/null; exit 0; fi',
  'mkdir -p "$(dirname "$f")"',
  'umask 077',
  // 文件已存在但缺这个 workdir 的信任项：交给 node 合并，不能整体覆盖——那会抹掉
  // claude 自己攒的会话/缓存状态。没有 node 时退回"只在文件不存在时写"，
  // 至少不破坏已有内容。
  'if [ -f "$f" ]; then',
  '  if command -v node >/dev/null 2>&1; then',
  '    node -e \'const fs=require("fs"),f=process.argv[1];const cur=JSON.parse(fs.readFileSync(f,"utf8"));const add=JSON.parse(fs.readFileSync(0,"utf8"));cur.projects={...(cur.projects??{}),...add.projects};for(const k of Object.keys(add))if(k!=="projects")cur[k]??=add[k];fs.writeFileSync(f,JSON.stringify(cur,null,2)+"\\n")\' "$f"',
  '  else',
  '    cat >/dev/null',
  '  fi',
  '  exit 0',
  'fi',
  'cat > "$f"',
].join('\n');
/**
 * `--output-format stream-json` is REFUSED by claude unless `--verbose` is also on
 * (`Error: --output-format=stream-json requires --verbose`). That is why the platform
 * adds it here rather than leaving it to the caller: a Task whose whole output
 * contract is stream-json cannot be one forgotten flag away from producing nothing.
 * It is also the reason `--verbose` is the ONE value on the `extraArgs` whitelist
 * (`TaskExtraArgSchema`) — a caller passing it explicitly is de-duplicated below.
 */
const STREAM_JSON_ARGS = ['--output-format', 'stream-json', '--verbose'];
/** `install()` takes no image; the npm commands are image-independent (see codex). */
const ANY_IMAGE: ResolvedImageSpec = { ref: '', digest: '' };

/**
 * Claude Code RuntimeAdapter (docs/backend/04 §3, 05 §1 ★1). Account login =
 * `setup-token`: the auth URL is hidden in an OSC-8 escape (parse it, don't grep),
 * the user authorizes, and the 1-year token (`sk-ant-oat01-…`) is printed to stdout
 * FOLDED across lines → reconstruct + validate PREFIX/LENGTH/CHARSET before storing
 * (P1-4c). Injection = `CLAUDE_CODE_OAUTH_TOKEN` env (applied at sandbox start).
 */
@Injectable()
export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly vendor = 'Anthropic';

  /**
   * Claude's own credential lifetimes (05 §5): a `setup-token` (`sk-ant-oat01-…`) is
   * valid ~1 year and is NOT refreshable (hence no `refreshCapability`). `api-key` is
   * absent on purpose — an Anthropic key has no expiry.
   */
  readonly credentialTtlMs: Readonly<Partial<Record<RuntimeAuthMethod, number>>> = {
    'setup-token': 365 * 24 * 60 * 60_000,
  };

  getAuthMethods(): RuntimeAuthMethod[] {
    return ['setup-token', 'api-key'];
  }

  /** Anthropic api-key FORMAT check (`sk-ant-…`), owned by the adapter (05 §3.1). */
  validateApiKey(secret: string): ApiKeyFormatVerdict {
    return validateAnthropicApiKey(secret);
  }

  loginCommand(method: RuntimeAuthMethod): string[] {
    if (method === 'setup-token') return ['claude', 'setup-token'];
    throw new AdapterAuthError(
      'UNSUPPORTED_METHOD',
      `claude has no interactive login for ${method}`,
    );
  }

  async beginAuth(method: RuntimeAuthMethod, ctx: AuthSessionContext): Promise<AuthChallenge> {
    if (method !== 'setup-token') {
      throw new AdapterAuthError('UNSUPPORTED_METHOD', `claude beginAuth: ${method}`);
    }
    const url = await readUntil(
      ctx.pty,
      (s) => parseClaudeAuthUrl(s),
      BEGIN_TIMEOUT_MS,
      'claude setup-token 打印授权链接（OSC-8 超链接）',
    );
    return {
      challengeRef: ctx.challengeRef,
      method: 'setup-token',
      kind: 'paste-prompt',
      verificationUrl: url,
      // ⛔ **两条路都要说**（2026-09-07 真机改）。这句话原本是
      //    「打开链接完成授权，然后把页面给出的授权码粘贴回来提交」—— 只对**远端部署**
      //    成立。`claude setup-token` 会起一个本地监听，浏览器与平台在同一台机器时，
      //    回调页把码**直接送进那个端口**，页面只显示「成功，可以关闭此窗口」，
      //    **根本不给码**。用户照着这句话去找码，就会以为自己漏了一步（真机复现）。
      instructions:
        '在浏览器打开链接完成授权。' +
        '**多数情况下不需要做别的**：页面显示「可以关闭此窗口」就说明授权已经自动送回，' +
        '这里会自己变成已配置。' +
        '只有当页面**显示了一串授权码**时（浏览器与平台不在同一台机器时才会这样），' +
        '才需要把它粘贴到下面提交。',
    };
  }

  async completeAuth(
    _challenge: AuthChallenge,
    input: AuthCompletionInput,
    ctx: AuthSessionContext,
  ): Promise<RuntimeCredential> {
    if (input.cancel) throw new AdapterAuthError('AUTH_REJECTED', 'login cancelled');
    if (!input.pastedText) {
      throw new AdapterAuthError('AUTH_REJECTED', 'setup-token requires pastedText');
    }
    // Feed the pasted authorization code into the CLI's stdin (never argv).
    ctx.pty.write(`${input.pastedText.trim()}\n`);
    return await this.readSetupToken(ctx);
  }

  /**
   * ⭐ **CLI 自己完成**那条路：什么都不写，只等 token 自己出现在 PTY 上。
   *
   * 浏览器把授权码送进 CLI 的本地监听之后，CLI 会直接把 token 打出来 —— 那时既没有码
   * 可粘，也不需要粘。契约上那段注释记着这条路此前完全没被接住。
   *
   * ⚠️ 预算与 `completeAuth` 同为 `COMPLETE_TIMEOUT_MS`：两条路等的是同一件事
   * （token 出现），只是触发方式不同，**耐心没有理由不一样**。
   */
  async awaitSelfCompletion(
    _challenge: AuthChallenge,
    ctx: AuthSessionContext,
  ): Promise<RuntimeCredential> {
    return await this.readSetupToken(ctx);
  }

  /**
   * 从 PTY 上读出 setup-token 并做成凭证 —— **两条完成路径共用的那一半**。
   *
   * ⛔ 抽出来是因为它们**必须一字不差**：入库前的 PREFIX+LENGTH+CHARSET 校验、掩码形态、
   * `env` 注入位、`zeroize` —— 任何一处只在其中一条路上做对，就等于那条路存在一个
   * 静默的凭证缺陷。两份实现迟早分叉，这一份不会。
   */
  private async readSetupToken(ctx: AuthSessionContext): Promise<RuntimeCredential> {
    const token = await readUntil(
      ctx.pty,
      (s) => parseClaudeSetupToken(s),
      COMPLETE_TIMEOUT_MS,
      'claude setup-token 打印 token',
    );
    // 入库前 PREFIX+LENGTH+CHARSET 校验 (P1-4c): a fold-mangled token is rejected here,
    // never silently stored.
    const verdict = validateClaudeOauthToken(token);
    if (!verdict.ok) {
      throw new AdapterAuthError('AUTH_REJECTED', `invalid setup-token: ${verdict.reason}`);
    }
    const clean = token.trim();
    const cred: RuntimeCredential = {
      runtimeId: 'claude-code',
      obtainedVia: 'setup-token',
      maskedIdentifier: `sk-ant-oat01-…${clean.slice(-4)}`,
      issuedAt: '',
      env: { CLAUDE_CODE_OAUTH_TOKEN: clean },
      credentialFiles: [],
      zeroize(): void {
        cred.env = undefined;
      },
    };
    return cred;
  }

  async createCredentialFromSecret(
    method: 'api-key' | 'access-token-paste',
    secret: string,
  ): Promise<RuntimeCredential> {
    if (method !== 'api-key') {
      throw new AdapterAuthError(
        'UNSUPPORTED_METHOD',
        `claude createCredentialFromSecret: ${method}`,
      );
    }
    const key = secret.trim();
    const cred: RuntimeCredential = {
      runtimeId: 'claude-code',
      obtainedVia: 'api-key',
      maskedIdentifier: `sk-…${key.slice(-4)}`,
      issuedAt: '',
      env: { ANTHROPIC_API_KEY: key },
      credentialFiles: [],
      zeroize(): void {
        cred.env = undefined;
      },
    };
    return cred;
  }

  // ── run half (04 §3) ───────────────────────────────────────────────────────

  /**
   * (image, runtime) verdict — PURE (04 §3 ★1). This is the exact case that proves
   * the plan must be keyed on the PAIR: the AIO default image has NO claude-code and
   * a cold `npm i -g @anthropic-ai/claude-code` there was measured at 753 SECONDS,
   * while the boxlite reference image ships it and installs nothing.
   */
  getInstallPlan(imageSpec: ResolvedImageSpec): RuntimeInstallPlan {
    return npmInstallPlan({
      packageName: '@anthropic-ai/claude-code',
      binary: CLAUDE_BINARY,
      preinstalled: imagePreinstalls(imageSpec, 'claude-code'),
      estimatedInstallSec: 753,
    });
  }

  /** PATH lookup + real `--version` (RA-01); never a hard-coded install path. */
  isInstalled(exec: SandboxExecFn): Promise<boolean> {
    return probeOnPath(exec, CLAUDE_BINARY);
  }

  /** Re-enterable: `npm i -g` converges when re-run after a partial failure (RA-02). */
  async install(exec: SandboxExecFn): Promise<void> {
    await runInstallCommands(exec, this.getInstallPlan(ANY_IMAGE).packageManagerCmds);
  }

  /** Start claude on a task, with its approval prompts turned off (see above). */
  buildStartCommand(task: RuntimeTaskSpec): SandboxCommand {
    const cmd = [CLAUDE_BINARY, ...PERMISSIONS_OFF_ARGS];
    if (task.headless) cmd.push('--print');
    if (task.headless && task.outputFormat === 'json-stream') cmd.push(...STREAM_JSON_ARGS);
    // Resumption is a FLAG here, where codex needs a whole different subcommand
    // (04 §3 ★4) — the shapes have nothing in common, which is why this lives per
    // adapter and never in platform code. Measured: cwd does NOT constrain an
    // id-based `--resume` (the encoded-cwd bucket only binds `-c/--continue`), so no
    // workdir pinning is needed.
    if (task.resumeFrom !== undefined && task.resumeFrom !== '') {
      // the id is validated at the door (`RunAgentTaskSchema.resumeFrom`), and it is
      // an option VALUE here rather than a positional, so clap consumes it verbatim.
      cmd.push('--resume', assertSessionRef(task.resumeFrom));
    }
    if (task.extraArgs) cmd.push(...task.extraArgs.filter((a) => !cmd.includes(a)));
    // ⚠️ `--` CLOSES THE OPTION LIST, AND IT IS A SECURITY BOUNDARY, NOT TIDINESS.
    // `prompt` is caller-supplied and lands in argv as a POSITIONAL; without the
    // terminator a prompt that begins with `-` is parsed as an OPTION instead — which
    // is a complete bypass of the `extraArgs` whitelist that exists precisely because
    // "anything appended to argv executes". Everything after `--` is data.
    if (task.prompt !== undefined && task.prompt !== '') cmd.push('--', task.prompt);
    return { cmd, cwd: task.workdir, env: { ...DELIBERATE_SANDBOX_ENV } };
  }

  /**
   * Structured stdout → `RuntimeEvent[]` (04 §3 `parseOutput`).
   *
   * Fed `JobChunk.stdout` ONLY — never stderr (04 §2.6 裁决 3). Stateless per call:
   * the job plane guarantees whole lines, so replaying the persisted raw log later
   * yields the identical event sequence, which is what keeps `fromSeq` replay dense.
   */
  parseOutput(chunk: Buffer): RuntimeEvent[] {
    return parseClaudeTaskEvents(chunk.toString('utf8'));
  }

  /** A plain interactive claude session — same permission switch, no instruction. */
  buildAttachCommand(): SandboxCommand {
    // ⚠️ 交互会话与任务**走同一条命令行**，那道 root 闸门自然也一样拦 —— 两处都要声明。
    return { cmd: [CLAUDE_BINARY, ...PERMISSIONS_OFF_ARGS], env: { ...DELIBERATE_SANDBOX_ENV } };
  }

  /**
   * claude injects via `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` env at sandbox
   * start — no file, no argv, no exec needed here (05 §4). The parameter type carries
   * no `authFile` (05 §4.3 裁决 D-18); claude's setup-token has no refresh token at all,
   * so this adapter has nothing to sanitize, but it obeys the same injection contract.
   */
  /** 启动前清掉四道交互闸门（理由与实测见 `CLAUDE_CONFIG_PATH` 上方）。每次 provision 都跑，幂等。 */
  async seedStartupFiles(spec: RuntimeStartupSpec, exec: SandboxExecFn): Promise<void> {
    // ⚠️ 探不到 HOME 是**基础设施失败**，不是鉴权失败。codex 侧把它包成
    // `AdapterAuthError('AUTH_REJECTED')` 其实是误标（那条路径的历史包袱）；
    // 这里保持裸 Error，由 workflow 统一 catch 成 WARN。两处语义不同是有意的，
    // 不是漏改 —— 别为了"一致"把这里也贴上 AUTH_REJECTED。
    const home = await probeSandboxHome(exec, (m) => new Error(m));
    const absolutePath = `${home}/${CLAUDE_CONFIG_PATH.slice(2)}`;
    // needle：这次 workdir 对应的那一项。命中即认为已经种过。
    const needle = `"${spec.workdir}"`;
    const r = await exec(['sh', '-c', SEED_CLAUDE_SCRIPT, 'claude-seed', absolutePath, needle], {
      stdin: claudeSeedJson(spec.workdir),
      timeoutMs: SEED_WRITE_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) {
      throw new Error(`seeding claude .claude.json failed (exit ${r.exitCode})`);
    }
  }

  async injectCredential(cred: InjectableRuntimeCredential, _exec: SandboxExecFn): Promise<void> {
    if (!cred.env || Object.keys(cred.env).length === 0) {
      throw new AdapterAuthError('AUTH_REJECTED', 'no injectable claude credential material');
    }
    // env is applied at sandbox START by the orchestration; nothing to exec.
    return;
  }
}
