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
  sanitizeCodexAuthJson,
} from './codex.output-parser';

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
    const cmd = [CODEX_BINARY];
    if (task.headless) cmd.push('exec');
    cmd.push(...SANDBOX_OFF_ARGS);
    if (task.headless && task.outputFormat === 'json-stream') cmd.push('--json');
    if (task.extraArgs) cmd.push(...task.extraArgs);
    if (task.prompt !== undefined && task.prompt !== '') cmd.push(task.prompt);
    return { cmd, cwd: task.workdir };
  }

  /** A plain interactive codex session — same inner-sandbox switch, no instruction. */
  buildAttachCommand(): SandboxCommand {
    return { cmd: [CODEX_BINARY, ...SANDBOX_OFF_ARGS] };
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
