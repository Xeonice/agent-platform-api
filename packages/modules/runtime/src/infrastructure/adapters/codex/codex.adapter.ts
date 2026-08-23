import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import type {
  ApiKeyFormatVerdict,
  AuthChallenge,
  AuthCompletionInput,
  AuthSessionContext,
  InjectableRuntimeCredential,
  RefreshedRuntimeAuth,
  RuntimeAdapter,
  RuntimeAuthMethod,
  RuntimeCredential,
  RuntimeCredentialFile,
  RuntimeStartupSpec,
  RuntimeEvent,
  RuntimeInstallPlan,
  RuntimeRefreshCapability,
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
import { AdapterAuthError } from '../../../domain/errors/adapter-auth.error';
import { validateOpenAiApiKey } from '../../../domain/services/token-format.validator';
import { readUntil } from '../pty-reader.util';
import {
  codexLoginSucceeded,
  parseCodexAuthJson,
  parseCodexDeviceChallenge,
  parseCodexTaskEvents,
  sanitizeCodexAuthJson,
} from './codex.output-parser';
import { assertSessionRef } from '../session-ref.util';

const BEGIN_TIMEOUT_MS = 60_000;
const COMPLETE_TIMEOUT_MS = 15 * 60_000;
const HOME_PROBE_TIMEOUT_MS = 15_000;
const WRITE_FILE_TIMEOUT_MS = 30_000;

const CODEX_BINARY = 'codex';
/**
 * Turn OFF codex's built-in bwrap sandbox (04 §3 ★2). `--dangerously-bypass-approvals
 * -and-sandbox` is the other documented spelling; `-s danger-full-access` is the one
 * verified live in S5.
 */
const SANDBOX_OFF_ARGS = ['-s', 'danger-full-access'];
/**
 * The same capability for `codex exec resume`, which does NOT accept `-s/--sandbox`
 * (04 §3 ★4, measured). The value keeps its TOML quotes because argv reaches the CLI
 * WITHOUT shell processing — the provider quotes each element for transport, so what
 * codex sees is the literal `sandbox_mode="danger-full-access"`, a valid TOML string.
 */
const RESUME_SANDBOX_OFF_ARGS = ['-c', 'sandbox_mode="danger-full-access"'];
/**
 * 无头路径的**硬闸门**（实测 codex-cli 0.139.0）：在非 git 目录里 `codex exec` 直接拒跑——
 *
 *   Not inside a trusted directory and --skip-git-repo-check was not specified.
 *
 * 这不是提示、是**退出**。空项目（`sourceType: 'empty'`）的工作区就是一个普通目录,
 * 于是 S6 整条无头 Task 链路在空项目上一次都跑不起来。
 *
 * ⚠️ 实测过的两条错路,别再走:
 *   ① `-c projects."<dir>".trust_level="trusted"` —— **对这道闸门无效**。它认的是
 *      "是不是 git 仓库",与目录信任是**两道不同的闸门**（交互路径那道见 §信任预置）;
 *   ② 让工作区变成 git 仓库 —— 那会污染用户的产物,而且空项目本来就不该有 .git。
 *
 * 这个 flag 只在 `exec` / `exec resume` 上存在,顶层交互命令没有（实测 `--help`）。
 */
const SKIP_GIT_REPO_CHECK = '--skip-git-repo-check';
/**
 * 关掉启动时的版本检查。不关的话交互会话会先弹一个**需要按键**的升级菜单
 * （"Update available! 0.139.0 -> 0.149.0 / 1. Update now …"）,把 agent 卡在那里;
 * 而且平台管着 CLI 的安装（`getInstallPlan`）,让 agent 自己 `npm install -g` 换版本
 * 会绕过平台对版本的掌控。与 `-c` 同族,两条路径都能用。
 */
const NO_UPDATE_CHECK_ARGS = ['-c', 'check_for_update_on_startup=false'];
/**
 * 第三道闸门:首次在某目录里启动,codex 会停在 "Do you trust the contents of this
 * directory?" 等人按键——**没凭证也一样停**,于是 agent 连"我没登录"都报不出来,
 * 界面上只是一个不动的终端。
 *
 * 实测(codex-cli 0.139.0)确认这道闸门**只认配置文件**:
 *   · `-c projects."<dir>".trust_level="trusted"` —— 无效;
 *   · `--dangerously-bypass-approvals-and-sandbox` —— 也无效;
 *   · 手工答一次 Yes 之后,codex 往 `$CODEX_HOME/config.toml` 写的正是下面这两行,
 *     预置它再起就直接进 TUI。
 *
 * ── 替用户答"信任"安全吗:实测过,不是推的 ──────────────────────────────────
 * 真正值得担心的是恶意仓库借**项目级** `.codex/config.toml` 把模型端点改道,
 * 把平台注入的凭证送去攻击者那里(本文件 `--` 那段注释防的就是同一类攻击)。
 * 实测:在工作区放一份带 `openai_base_url` + `model_providers` 的项目级配置,
 * codex 自己拒绝加载并打印
 *   `warning: Ignored unsupported project-local config keys … openai_base_url,
 *    model_providers. If you want these settings to apply, manually set them in
 *    your user-level config.toml.`
 * 请求仍然发往 `wss://api.openai.com`。**这条外泄路径由 codex 自己关掉了。**
 * 残余的 hooks / exec policies 不给 agent 任何它在容器里没有的能力
 * (`-s danger-full-access` 已经全开,容器本身才是隔离边界)。
 */
const TRUST_SECTION = (workdir: string): string => `[projects."${workdir}"]`;
const TRUST_BLOCK = (workdir: string): string =>
  `\n${TRUST_SECTION(workdir)}\ntrust_level = "trusted"\n`;
const CODEX_CONFIG_PATH = '~/.codex/config.toml';
/**
 * 幂等且**不覆盖**:配置文件可能已有用户自己的设置(或上一轮 provision 落的同一段)。
 * 命中则原样跳过——但仍然把 stdin 读干净,否则写端拿 EPIPE。
 */
const SEED_TRUST_SCRIPT = [
  'set -e',
  'f="$1"',
  'mkdir -p "$(dirname "$f")"',
  'if grep -qF "$2" "$f" 2>/dev/null; then cat >/dev/null; exit 0; fi',
  'cat >> "$f"',
].join('\n');
/**
 * `install()` takes no image (04 §3), while `getInstallPlan` is keyed on one. The
 * install COMMANDS are image-independent for an npm-distributed CLI — only the
 * strategy/estimate differ — so a neutral spec is used to read them back.
 */
const ANY_IMAGE: ResolvedImageSpec = { ref: '', digest: '' };

/** Where codex reads its credential — `~/`-relative; `$HOME` is expanded at inject time. */
const CODEX_AUTH_FILE_PATH = '~/.codex/auth.json';
/** Credential material is always owner-only. */
const CREDENTIAL_FILE_MODE = '0600';
const MODE_RE = /^[0-7]{3,4}$/;

/**
 * Ask the LIVE sandbox for its `$HOME` (05 §4.3 裁决 D-19). `printf` (not `echo`) so
 * there is no trailing newline to guess at, and no shell expansion of the value.
 */
const HOME_PROBE_CMD = ['sh', '-c', 'printf %s "$HOME"'];

/**
 * Write `$1` with mode `$2`, taking the CONTENT FROM STDIN — the content never appears
 * in argv (`/proc/<pid>/cmdline` is world-readable inside the sandbox; RA-14). `umask
 * 077` closes the window between `cat >` creating the file and `chmod` tightening it,
 * so the file is never briefly group/world-readable. The path is passed as a positional
 * argument rather than interpolated, so no path can be parsed as shell syntax.
 */
const WRITE_FILE_SCRIPT =
  'set -e; mkdir -p "$(dirname "$1")"; umask 077; cat > "$1"; chmod "$2" "$1"';

/**
 * Codex RuntimeAdapter (docs/backend/04 §3, 05 §1 ★2 / §1★★). Account login =
 * device-auth (plain-text code + read `auth.json`); api-key = short-circuit.
 *
 * INJECTION obeys the minimal-exposure priority as revised by the S5 技术验证 (05 §1★★):
 *   ① a `0600` `~/.codex/auth.json` whose `refresh_token` VALUE is the shared-kernel
 *      placeholder — the field is kept (codex fails with `missing field 'refresh_token'`
 *      otherwise), the real value never leaves the platform;
 *   ② (OPTIONAL, VERSION-SENSITIVE) access-token-only on STDIN (`codex login
 *      --with-access-token`) — a token minted by 0.147.0 is rejected by 0.139.0, so this
 *      only works when the minting and consuming CLI versions match;
 *   ③ (BANNED) the whole `auth.json` with a real refresh_token, via file OR env — one
 *      `echo` inside the sandbox steals a credential the platform cannot revoke
 *      upstream (P0-3). `CODEX_AUTH_JSON` is never set.
 *
 * The sanitized form in ① is produced at credential BIRTH (`completeAuth` /
 * `parseRefreshedAuth`), never here: `injectCredential` takes an
 * `InjectableRuntimeCredential`, which structurally has no `authFile`, and it writes
 * file content out VERBATIM — no JSON parsing, no field rewriting (05 §4.3 裁决 D-18).
 */
@Injectable()
export class CodexAdapter implements RuntimeAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  readonly vendor = 'OpenAI';

  /**
   * Codex's own credential lifetimes (05 §5): the device-auth account credential is a
   * ~1h access token. `api-key` is absent on purpose — an OpenAI key has no expiry.
   * The application layer stamps `credentials.expires_at` from THIS table, so no
   * platform-level "oauth-device ⇒ 1 hour" assumption leaks onto other runtimes.
   */
  readonly credentialTtlMs: Readonly<Partial<Record<RuntimeAuthMethod, number>>> = {
    'oauth-device': 60 * 60_000,
  };

  /**
   * Codex account credential = an hourly access token the CLI refreshes itself from a
   * seeded `auth.json` (05 §5.1). The scanner reads the probe command + parser here —
   * it no longer hard-codes `['codex','whoami']` / `parseCodexAuthJson`.
   */
  readonly refreshCapability: RuntimeRefreshCapability = {
    probeCommand: ['codex', 'whoami'],
    /**
     * A refresh MINTS a credential just as much as a login does, so it produces the
     * SAME split (05 §4.3 ②): the fresh access token, plus the re-sanitized injectable
     * `auth.json`. Returning only the token would leave every post-refresh injection
     * with a stale (or absent) file — the silent degradation this split exists to stop.
     */
    parseRefreshedAuth(raw: string): RefreshedRuntimeAuth {
      const auth = parseCodexAuthJson(raw);
      const access = auth.tokens?.access_token;
      if (!access) throw new Error('refreshed auth.json missing access_token');
      return { accessToken: access, credentialFiles: [sanitizedAuthFile(raw)] };
    },
  };

  getAuthMethods(): RuntimeAuthMethod[] {
    return ['oauth-device', 'api-key'];
  }

  /** OpenAI api-key FORMAT check (`sk-…`), owned by the adapter (05 §3.1). */
  validateApiKey(secret: string): ApiKeyFormatVerdict {
    return validateOpenAiApiKey(secret);
  }

  loginCommand(method: RuntimeAuthMethod): string[] {
    if (method === 'oauth-device') return ['codex', 'login', '--device-auth'];
    throw new AdapterAuthError(
      'UNSUPPORTED_METHOD',
      `codex has no interactive login for ${method}`,
    );
  }

  async beginAuth(method: RuntimeAuthMethod, ctx: AuthSessionContext): Promise<AuthChallenge> {
    if (method !== 'oauth-device') {
      throw new AdapterAuthError('UNSUPPORTED_METHOD', `codex beginAuth: ${method}`);
    }
    const challenge = await readUntil(
      ctx.pty,
      (s) => parseCodexDeviceChallenge(s),
      BEGIN_TIMEOUT_MS,
    );
    return {
      challengeRef: ctx.challengeRef,
      method: 'oauth-device',
      kind: 'device-code',
      verificationUrl: challenge.verificationUrl,
      userCode: challenge.userCode,
      expiresAt: ctx.deviceCodeExpiresAt,
      instructions: `在浏览器打开 ${challenge.verificationUrl} 并输入设备码 ${challenge.userCode} 完成授权。`,
    };
  }

  async completeAuth(
    _challenge: AuthChallenge,
    input: AuthCompletionInput,
    ctx: AuthSessionContext,
  ): Promise<RuntimeCredential> {
    if (input.cancel) throw new AdapterAuthError('AUTH_REJECTED', 'login cancelled');
    // device-auth: the user authorizes in their browser; wait for the CLI to confirm.
    await readUntil(ctx.pty, (s) => (codexLoginSucceeded(s) ? true : null), COMPLETE_TIMEOUT_MS);
    const raw = await readFile(join(ctx.homeDir, 'auth.json'), 'utf8');
    const auth = parseCodexAuthJson(raw);
    const access = auth.tokens?.access_token;
    if (!access || access.length === 0) {
      throw new AdapterAuthError('AUTH_REJECTED', 'codex auth.json missing access_token');
    }
    const accountId = auth.tokens?.account_id ?? '';
    const masked = accountId ? `codex:…${accountId.slice(-4)}` : 'codex account';
    // BIRTH-TIME SPLIT (05 §4.3 ②): the sanitized file for injection and the complete
    // file for the platform's own refresh scanner are produced HERE, side by side, and
    // stored in two separate payload fields. Nothing downstream converts between them.
    const cred: RuntimeCredential = {
      runtimeId: 'codex',
      obtainedVia: 'oauth-device',
      maskedIdentifier: masked,
      issuedAt: '',
      accessToken: access,
      authFile: raw, // platform-only (refresh scanner); structurally unreachable from injection
      credentialFiles: [sanitizedAuthFile(raw)],
      zeroize(): void {
        cred.accessToken = undefined;
        cred.authFile = undefined;
        for (const f of cred.credentialFiles) f.content = '';
        cred.credentialFiles = [];
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
        `codex createCredentialFromSecret: ${method}`,
      );
    }
    const key = secret.trim();
    const cred: RuntimeCredential = {
      runtimeId: 'codex',
      obtainedVia: 'api-key',
      maskedIdentifier: `sk-…${key.slice(-4)}`,
      issuedAt: '',
      env: { OPENAI_API_KEY: key },
      credentialFiles: [],
      zeroize(): void {
        cred.env = undefined;
      },
    };
    return cred;
  }

  /**
   * Inject via the lowest-exposure channel available, in the 05 §1★★ priority order.
   *
   * The parameter is an `InjectableRuntimeCredential`: it has no `authFile` field, so
   * the real refresh token is not something this method may forget to strip — it is
   * something this method cannot see (05 §4.3 裁决 D-18 ①).
   */
  /**
   * 启动前把"这个工作目录是可信的"写进 codex 的用户级配置(见 `TRUST_BLOCK` 上方
   * 那段实测记录)。每次 provision 都跑(含重启),故必须幂等——脚本里 `grep -qF` 命中
   * 就原样跳过。
   */
  async seedStartupFiles(spec: RuntimeStartupSpec, exec: SandboxExecFn): Promise<void> {
    const home = await this.probeHome(exec);
    const absolutePath = `${home}/${CODEX_CONFIG_PATH.slice(2)}`;
    const r = await exec(
      ['sh', '-c', SEED_TRUST_SCRIPT, 'codex-seed', absolutePath, TRUST_SECTION(spec.workdir)],
      { stdin: TRUST_BLOCK(spec.workdir), timeoutMs: WRITE_FILE_TIMEOUT_MS },
    );
    if (r.exitCode !== 0) {
      throw new Error(`seeding codex config.toml failed (exit ${r.exitCode})`);
    }
  }

  async injectCredential(cred: InjectableRuntimeCredential, exec: SandboxExecFn): Promise<void> {
    // ① default: 0600 credential files, content written out VERBATIM.
    if (cred.credentialFiles.length > 0) {
      const home = await this.probeHome(exec);
      for (const file of cred.credentialFiles) {
        await this.writeFile(exec, file, home);
      }
      return;
    }
    // ② optional / version-sensitive: access-token-only on stdin.
    if (cred.accessToken && cred.accessToken.length > 0) {
      const r = await exec(['codex', 'login', '--with-access-token'], {
        stdin: cred.accessToken,
        timeoutMs: WRITE_FILE_TIMEOUT_MS,
      });
      if (r.exitCode !== 0) {
        throw new AdapterAuthError('AUTH_REJECTED', `codex --with-access-token exit ${r.exitCode}`);
      }
      return;
    }
    if (cred.env && Object.keys(cred.env).length > 0) return; // env applied at start
    throw new AdapterAuthError('AUTH_REJECTED', 'no injectable codex credential material');
  }

  // ── run half (04 §3) ───────────────────────────────────────────────────────

  /**
   * (image, runtime) verdict — PURE (04 §3 ★1). The AIO default image ships
   * `@openai/codex` preinstalled (measured 0.139.0), so on that family this is a
   * zero-install; anywhere else the platform falls back to installing it on start.
   */
  getInstallPlan(imageSpec: ResolvedImageSpec): RuntimeInstallPlan {
    return npmInstallPlan({
      packageName: '@openai/codex',
      binary: CODEX_BINARY,
      preinstalled: imagePreinstalls(imageSpec.ref, 'codex'),
      // measured on a cold AIO default image; codex is the SMALL one of the two.
      estimatedInstallSec: 120,
    });
  }

  /**
   * PATH lookup + a real `--version` (RA-01). Never a hard-coded path: the npm prefix
   * is the user-level `/home/gem/.npm-global` and `codex` actually resolves through an
   * fnm shim (`/home/gem/.fnm_shell/bin/codex`), so any constant path is wrong on BOTH
   * built-in providers (04 §2.1★).
   */
  isInstalled(exec: SandboxExecFn): Promise<boolean> {
    return probeOnPath(exec, CODEX_BINARY);
  }

  /** Re-enterable by construction: `npm i -g` converges on a re-run (RA-02, ~6s). */
  async install(exec: SandboxExecFn): Promise<void> {
    await runInstallCommands(exec, this.getInstallPlan(ANY_IMAGE).packageManagerCmds);
  }

  /**
   * Start codex on a task. `-s danger-full-access` DISABLES codex's own bwrap sandbox
   * (04 §3 ★2) — not laziness: bwrap needs a mount namespace, which is refused inside
   * BOTH providers, and the observed failure mode is vicious (auth succeeds, the model
   * really runs, every file write is blocked, and the agent simply reports "I can't
   * change files"). The real boundary is the container/microVM around us, and our own
   * data-plane agent is already an unauthenticated shell inside it, so the inner layer
   * blocks nothing that is not already reachable. Making bwrap work would instead mean
   * granting the container `SYS_ADMIN` — weakening the layer that actually works.
   */
  buildStartCommand(task: RuntimeTaskSpec): SandboxCommand {
    const resume = task.resumeFrom !== undefined && task.resumeFrom !== '';
    const cmd = [CODEX_BINARY];
    if (task.headless) cmd.push('exec');
    // ⚠️ RESUME IS A DIFFERENT SUBCOMMAND WITH A DIFFERENT OPTION SET, not the start
    // argv with a flag added (04 §3 ★4, measured): `codex exec resume` has neither
    // `-s/--sandbox` nor `-C/--cd`, so appending `-s danger-full-access` dies with
    // `unexpected argument '-s' found`. The equivalent goes through `-c`. Assume
    // nothing carries over between the two subcommands.
    if (resume) cmd.push('resume', ...RESUME_SANDBOX_OFF_ARGS);
    else cmd.push(...SANDBOX_OFF_ARGS);
    cmd.push(...NO_UPDATE_CHECK_ARGS);
    // 只有 exec 一族有这个 flag；顶层交互命令加了会 `unexpected argument` 直接死。
    if (task.headless) cmd.push(SKIP_GIT_REPO_CHECK);
    if (task.headless && task.outputFormat === 'json-stream') cmd.push('--json');
    if (task.extraArgs) cmd.push(...task.extraArgs);
    // ⚠️ `--` CLOSES THE OPTION LIST BEFORE THE FIRST POSITIONAL, AND IT IS A SECURITY
    // BOUNDARY. Both values after it are caller-supplied; without the terminator clap
    // reads any leading `-` as an option, which is a total bypass of the `extraArgs`
    // whitelist. The concrete case: `resumeFrom = "-cmodel_provider.base_url=http://…"`
    // is accepted as `-c` config override, and codex's credentials live in
    // `~/.codex/auth.json` — i.e. the injected key is sent to an attacker's endpoint.
    // (The format check below refuses that value too; both layers stay.)
    if (resume || (task.prompt !== undefined && task.prompt !== '')) cmd.push('--');
    // the reference is a POSITIONAL of `resume`, so it precedes the prompt.
    if (resume) cmd.push(assertSessionRef(task.resumeFrom as string));
    if (task.prompt !== undefined && task.prompt !== '') cmd.push(task.prompt);
    // `resume` also drops `-C/--cd`; `cwd` still travels because the platform sets the
    // working directory through the sandbox job, not through a codex flag.
    return { cmd, cwd: task.workdir };
  }

  /**
   * Structured stdout → `RuntimeEvent[]` (04 §3 `parseOutput`).
   *
   * ⚠️ IT IS FED `JobChunk.stdout` AND NEVER stderr (04 §2.6 裁决 3): merging the two
   * turns a measured 14/14 clean-JSONL run into 14 parseable + 8 garbage lines, which
   * is precisely the "write a regex and guess" fragility RA-04 names.
   *
   * It also relies on the job plane handing over WHOLE LINES — the provider keeps a
   * half line behind its cursor for exactly this reason — so no state is carried
   * between calls and the same bytes replayed later produce the same events, which is
   * what makes `fromSeq` replay off the platform's own log dense and stable.
   */
  parseOutput(chunk: Buffer): RuntimeEvent[] {
    return parseCodexTaskEvents(chunk.toString('utf8'));
  }

  /** A plain interactive codex session — same inner-sandbox switch, no instruction. */
  buildAttachCommand(): SandboxCommand {
    // attach 起的同样是**交互** codex ⇒ 同样会撞上启动版本检查那个需要按键的菜单。
    return { cmd: [CODEX_BINARY, ...SANDBOX_OFF_ARGS, ...NO_UPDATE_CHECK_ARGS] };
  }

  /**
   * Resolve THIS sandbox's `$HOME` (05 §4.3 裁决 D-19). Probed per injection through the
   * caller's `exec`, never hard-coded and never cached across sandboxes: the two
   * built-in providers happen to agree on `/home/gem` today, but 04 §7 is explicit that
   * HOME is not part of the image contract — a third-party image or a base-image bump
   * breaks any constant, and `/root` (the old guess) is wrong on BOTH providers.
   */
  private async probeHome(exec: SandboxExecFn): Promise<string> {
    const r = await exec(HOME_PROBE_CMD, { timeoutMs: HOME_PROBE_TIMEOUT_MS });
    const home = r.stdout.trim();
    if (r.exitCode !== 0 || !home.startsWith('/')) {
      throw new AdapterAuthError(
        'AUTH_REJECTED',
        `could not resolve $HOME inside the sandbox (exit ${r.exitCode})`,
      );
    }
    return home.endsWith('/') ? home.slice(0, -1) : home;
  }

  /** Materialize ONE credential file at its `~/`-expanded path, owner-only. */
  private async writeFile(
    exec: SandboxExecFn,
    file: RuntimeCredentialFile,
    home: string,
  ): Promise<void> {
    if (!file.containerPath.startsWith('~/')) {
      // 裁决 D-19: an absolute path here would mean the path was resolved before a
      // sandbox existed — i.e. against the wrong HOME, or pinning this credential to
      // one sandbox. Refuse rather than write to a guessed location.
      throw new AdapterAuthError(
        'AUTH_REJECTED',
        `credential file path must be ~/-relative, got '${file.containerPath}'`,
      );
    }
    const mode = file.mode && MODE_RE.test(file.mode) ? file.mode : CREDENTIAL_FILE_MODE;
    const absolutePath = `${home}/${file.containerPath.slice(2)}`;
    const r = await exec(['sh', '-c', WRITE_FILE_SCRIPT, 'codex-inject', absolutePath, mode], {
      stdin: file.content,
      timeoutMs: WRITE_FILE_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) {
      throw new AdapterAuthError(
        'AUTH_REJECTED',
        `writing ${file.containerPath} failed (exit ${r.exitCode})`,
      );
    }
  }
}

/** The one injectable file codex needs, already sanitized (05 §4.3 ②). */
function sanitizedAuthFile(rawAuthJson: string): RuntimeCredentialFile {
  return {
    containerPath: CODEX_AUTH_FILE_PATH,
    content: sanitizeCodexAuthJson(rawAuthJson),
    mode: CREDENTIAL_FILE_MODE,
  };
}
