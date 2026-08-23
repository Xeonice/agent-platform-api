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

const BEGIN_TIMEOUT_MS = 60_000;
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
  'if [ -f "$f" ]; then cat >/dev/null; exit 0; fi',
  'mkdir -p "$(dirname "$f")"',
  'umask 077',
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
    const url = await readUntil(ctx.pty, (s) => parseClaudeAuthUrl(s), BEGIN_TIMEOUT_MS);
    return {
      challengeRef: ctx.challengeRef,
      method: 'setup-token',
      kind: 'paste-prompt',
      verificationUrl: url,
      instructions: '在浏览器打开链接完成 claude.ai 授权，然后把页面给出的授权码粘贴回来提交。',
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
    const token = await readUntil(ctx.pty, (s) => parseClaudeSetupToken(s), COMPLETE_TIMEOUT_MS);
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
      preinstalled: imagePreinstalls(imageSpec.ref, 'claude-code'),
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
    return { cmd, cwd: task.workdir };
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
    return { cmd: [CLAUDE_BINARY, ...PERMISSIONS_OFF_ARGS] };
  }

  /**
   * claude injects via `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` env at sandbox
   * start — no file, no argv, no exec needed here (05 §4). The parameter type carries
   * no `authFile` (05 §4.3 裁决 D-18); claude's setup-token has no refresh token at all,
   * so this adapter has nothing to sanitize, but it obeys the same injection contract.
   */
  /** 启动前清掉四道交互闸门（理由与实测见 `CLAUDE_CONFIG_PATH` 上方）。每次 provision 都跑，幂等。 */
  async seedStartupFiles(spec: RuntimeStartupSpec, exec: SandboxExecFn): Promise<void> {
    const home = await probeSandboxHome(exec, (m) => new Error(m));
    const absolutePath = `${home}/${CLAUDE_CONFIG_PATH.slice(2)}`;
    const r = await exec(['sh', '-c', SEED_CLAUDE_SCRIPT, 'claude-seed', absolutePath], {
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
