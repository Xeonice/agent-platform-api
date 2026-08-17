import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Injectable } from '@nestjs/common';
import { simpleGit } from 'simple-git';
import type { SimpleGitOptions } from 'simple-git';
import type { GitCloner, CloneRequest } from '../../domain/ports/git-cloner.port';
import { CloneError } from '../../domain/ports/git-cloner.port';
import { parseCloneProgress } from './progress.parser';
import { classifyCloneError, sanitizeCloneMessage } from './error.classifier';

// env vars simple-git treats as unsafe (ambient config / askpass / ssh / proxy /
// pager …). We inherit PATH/HOME/http(s)_proxy etc. but DROP these — they must not
// leak from a CI/harness into project clones, and passing them trips simple-git.
const GUARDED_ENV = new Set([
  'GIT_ASKPASS',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_EDITOR',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_PROXY_COMMAND',
  'GIT_SEQUENCE_EDITOR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_TEMPLATE_DIR',
  'SSH_ASKPASS',
  // log-redaction (03 §7.3 G): a host-set trace would print
  // `Authorization: Basic base64(x-access-token:PAT)` into stderr → stderrTail.
  'GIT_TRACE',
  'GIT_TRACE_CURL',
  'GIT_CURL_VERBOSE',
  'GIT_TRACE_PACKET',
  // TLS is the HTTPS rebinding/MITM hard closure (03 §7.3 C4) — drop any ambient
  // GIT_SSL_NO_VERIFY so it can't silently disable cert validation.
  'GIT_SSL_NO_VERIFY',
]);

function cleanGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (GUARDED_ENV.has(upper)) continue;
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/i.test(k)) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/**
 * Merge the platform-generated auth env (from a `GitAuthContext`) on top of the
 * guarded ambient env. This runs AFTER `cleanGitEnv` so the injected GIT_CONFIG_*
 * (HTTPS credential.helper) and GIT_SSH_COMMAND survive the guard (03 §7.3 F) —
 * they are platform-authored values, not ambient pass-through.
 */
function mergeAuthEnv(base: Record<string, string>, req: CloneRequest): Record<string, string> {
  const env = { ...base };
  if (req.env) Object.assign(env, req.env);
  if (req.gitSshCommand) env.GIT_SSH_COMMAND = req.gitSshCommand;
  return env;
}

/**
 * simple-git blocks GIT_SSH_COMMAND / credential.helper / env-config-count as
 * "unsafe" by default. When (and only when) WE inject them — platform-generated,
 * never ambient (ambient was stripped by cleanGitEnv) — we opt in per category.
 */
function authUnsafe(req: CloneRequest): SimpleGitOptions['unsafe'] {
  const unsafe: NonNullable<SimpleGitOptions['unsafe']> = {};
  if (req.gitSshCommand) unsafe.allowUnsafeSshCommand = true;
  if (req.env && req.env.GIT_CONFIG_COUNT) {
    unsafe.allowUnsafeConfigEnvCount = true;
    unsafe.allowUnsafeCredentialHelper = true;
  }
  return unsafe;
}

/**
 * simple-git shallow cloner (docs/backend/03 §7.2). `--depth=1 --progress`; the
 * `--progress` stderr is parsed for the progress bar; the child is killed on the
 * caller's AbortSignal (cancel) and by a hard inactivity-immune timeout
 * (`timeout.block` with stdErr/stdOut resets disabled = a true wall-clock cap).
 * git's interactive credential prompts are disabled so private/bad URLs fail fast
 * instead of hanging.
 */
@Injectable()
export class SimpleGitCloner implements GitCloner {
  async clone(req: CloneRequest): Promise<void> {
    await mkdir(dirname(req.destPath), { recursive: true });
    const git = simpleGit({
      baseDir: dirname(req.destPath),
      abort: req.signal,
      timeout: { block: req.timeoutMs, stdErr: false, stdOut: false },
      unsafe: authUnsafe(req),
    });
    let stderrTail = '';
    git.outputHandler((_command, _stdout, stderr) => {
      stderr.on('data', (chunk: Buffer) => {
        const fragment = chunk.toString('utf8');
        stderrTail = (stderrTail + fragment).slice(-20_000);
        const progress = parseCloneProgress(fragment);
        if (progress) req.onProgress(progress);
      });
    });

    const args = ['--depth=1', '--progress'];
    if (req.repoBranch) args.push('--single-branch', '--branch', req.repoBranch);

    try {
      // GIT_TERMINAL_PROMPT=0 ⇒ never block on a credential prompt. We must NOT pass
      // through GIT_CONFIG_COUNT / GIT_CONFIG_{KEY,VALUE}_n (ambient config-in-env,
      // e.g. injected by CI/harness): simple-git rejects them as unsafe, and we do
      // not want ambient git config leaking into project clones anyway.
      await git.env(mergeAuthEnv(cleanGitEnv(), req)).clone(req.repoUrl, req.destPath, args);
    } catch (e) {
      if (req.signal.aborted) throw e; // cancel / timeout — the workflow classifies it
      const raw = e instanceof Error ? e.message : String(e);
      const combined = `${raw} ${stderrTail}`;
      throw new CloneError(classifyCloneError(combined), sanitizeCloneMessage(combined));
    }
  }
}
