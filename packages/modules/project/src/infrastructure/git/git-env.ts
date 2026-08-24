import type { SimpleGitOptions } from 'simple-git';

/**
 * The HERMETIC ENV every platform git child runs under (03 §7.3). Extracted from
 * `git-cloner.ts` when `POST /api/projects/:id/sync` gained a second network-touching
 * git command (`fetch --all`): a fetch that consulted an ambient credential helper or
 * an ambient ssh identity would re-open, for the sync path, exactly the hole the clone
 * path closed. One module, one set of rules, both callers.
 */

// env vars simple-git treats as unsafe (ambient config / askpass / ssh / proxy /
// pager …). We inherit PATH/HOME/http(s)_proxy etc. but DROP these — they must not
// leak from a CI/harness into project clones, and passing them trips simple-git.
const GUARDED_ENV = new Set([
  // simple-git's env vulnerability scanner rejects the PLAIN forms too — `EDITOR`,
  // `PAGER`, `PREFIX` — not just their `GIT_`-prefixed twins, and a rejected spawn
  // surfaces as an unclassified error, i.e. a BOGUS `CLONE_FAILED_NETWORK`. Vitest
  // sets `EDITOR` in its workers, which is exactly how this was found. An ambient
  // editor/pager has no business in a platform git child anyway.
  'EDITOR',
  'PAGER',
  'PREFIX',
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
  // REPO LOCATION (03 §7.2★ made this matter). `baseDir` does NOT pin which repository
  // git acts on — these outrank it. Inherited from a git hook or a harness, they would
  // send `fetch --all` into someone else's repository and make `branch -r` answer with
  // ITS branches, i.e. a picker offering names the baseline does not have. Harmless to
  // drop: every platform git command states its own repo via `baseDir`/`destPath`.
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
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

export function cleanGitEnv(): Record<string, string> {
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

/** The already-materialized auth products a git child may carry (03 §7.3). */
export interface GitAuthEnv {
  env?: Record<string, string>;
  gitSshCommand?: string;
}

/**
 * Merge the platform-generated auth env (from a `GitAuthContext`) on top of the
 * guarded ambient env. This runs AFTER `cleanGitEnv` so the injected GIT_CONFIG_*
 * (HTTPS credential.helper) and GIT_SSH_COMMAND survive the guard (03 §7.3 F) —
 * they are platform-authored values, not ambient pass-through.
 */
export function mergeAuthEnv(
  base: Record<string, string>,
  req: GitAuthEnv,
): Record<string, string> {
  const env = { ...base };
  if (req.env) Object.assign(env, req.env);
  if (req.gitSshCommand) env.GIT_SSH_COMMAND = req.gitSshCommand;
  // HERMETIC for the NO-CREDENTIAL (public / private-without-cred) path too.
  // The credentialed path gets a `credential.helper=''` reset (index 0) + host
  // helpers from the materializer; when we inject NO credential, `req.env` is
  // empty and — without this — git would consult an ambient/built-in helper
  // (notably macOS Apple Git's compiled-in osxkeychain, which is NOT an env var
  // and so survives cleanGitEnv) and use a host-cached token for a clone the
  // platform meant to run anonymously. So ALWAYS neutralize the helper chain:
  // no platform clone, credentialed or not, ever uses an ambient credential.
  if (!env.GIT_CONFIG_COUNT) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'credential.helper';
    env.GIT_CONFIG_VALUE_0 = '';
  }
  // Same discipline for SSH: without a platform-supplied key, offer NO ambient
  // identity (no `~/.ssh` keys / agent / config), so a no-cred SSH clone fails
  // instead of silently authenticating with a host key. Harmless over HTTPS
  // (GIT_SSH_COMMAND is only used by the ssh transport).
  if (!env.GIT_SSH_COMMAND) {
    env.GIT_SSH_COMMAND =
      'ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityAgent=none ' +
      '-o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=/dev/null';
  }
  return env;
}

/**
 * simple-git blocks GIT_SSH_COMMAND / credential.helper / env-config-count as
 * "unsafe" by default. We ALWAYS inject platform-authored values now — a
 * `credential.helper` reset (hermetic for credentialed AND no-cred clones, see
 * `mergeAuthEnv`) and a GIT_SSH_COMMAND — never ambient (ambient was stripped by
 * cleanGitEnv), so we opt into all three categories.
 */
export function authUnsafe(): SimpleGitOptions['unsafe'] {
  return {
    allowUnsafeSshCommand: true,
    allowUnsafeConfigEnvCount: true,
    allowUnsafeCredentialHelper: true,
  };
}
