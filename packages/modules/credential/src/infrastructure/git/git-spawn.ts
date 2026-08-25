import type { SimpleGitOptions } from 'simple-git';

/**
 * Shared git child-process hardening for the credential context (docs/backend/03
 * §7.3 F/G). Mirrors project's git-cloner guard: ambient unsafe git env is
 * stripped (incl. the GIT_TRACE* family so a host-set trace can't dump the
 * `Authorization:` header into stderr), then the platform-generated auth env is
 * merged AFTER the guard so the injected GIT_SSH_COMMAND / GIT_CONFIG_* survive.
 */
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
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_TEMPLATE_DIR',
  'SSH_ASKPASS',
  // log-redaction (G): a host-set trace would print Authorization: Basic <PAT> to stderr.
  // ⚠️ The `GIT_TRACE*` family is stripped BY PREFIX (`GIT_TRACE_PREFIX` below), not by
  // literals — only this non-prefixed member has to be named here.
  'GIT_CURL_VERBOSE',
  // TLS is the HTTPS rebinding/MITM hard closure (03 §7.3 C4): a server on a rebound
  // internal IP cannot present a valid cert for the SNI/Host. Drop any ambient
  // GIT_SSL_NO_VERIFY so it can't silently disable that. (CAINFO/CAPATH are kept so
  // an internal CA for self-hosted git still works — user's own trust domain.)
  'GIT_SSL_NO_VERIFY',
]);

/**
 * ⚠️ THE TRACE FAMILY IS MATCHED BY PREFIX, AND THAT IS NOT A TIDY-UP.
 *
 * `GUARDED_ENV` used to list four literals — `GIT_TRACE`, `GIT_TRACE_CURL`,
 * `GIT_TRACE_PACKET`, `GIT_CURL_VERBOSE` — under a comment claiming it covered
 * 「the GIT_TRACE* family」. It did not. git ships a whole SECOND generation of trace
 * variables the list never mentioned, and two of them are worse than the ones it had:
 *
 *   · `GIT_TRACE2` / `GIT_TRACE2_EVENT` / `GIT_TRACE2_PERF` — same dump, newer format;
 *   · `GIT_TRACE2_ENV_VARS` — prints the VALUES of the env vars you name into the
 *     trace, so a host that sets it to `GIT_TOKEN` gets the PAT written out verbatim;
 *   · `GIT_TRACE_REDACT=0` / `GIT_TRACE2_REDACT=0` — turn OFF git's own redaction of
 *     the `Authorization:` header. That redaction is the ONLY thing standing between
 *     a curl trace and the token in plaintext, and it is defeated by an env var the
 *     guard did not know existed.
 *
 * Plus `GIT_TRACE_SETUP` / `_PERFORMANCE` / `_PACK_ACCESS` / `_SHALLOW` / `_REFS`.
 *
 * Enumerating them is exactly how the hole got here: a literal list is a snapshot of
 * what one person recalled on one day, and git keeps adding members — the guard silently
 * ages out while the comment keeps promising a family. A prefix makes the code say what
 * the comment already claimed, and it covers the members git has not shipped yet.
 *
 * Cost, stated plainly: you can no longer debug a platform git child by exporting
 * `GIT_TRACE=1` on the host. That was already true of four of them; it is the price of
 * a child process that cannot be made to print its own credentials.
 */
const GIT_TRACE_PREFIX = /^GIT_TRACE/;

function cleanAmbientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (GUARDED_ENV.has(upper)) continue;
    if (GIT_TRACE_PREFIX.test(upper)) continue;
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/i.test(k)) continue;
    env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

export interface InjectedAuth {
  env?: Record<string, string>;
  gitSshCommand?: string;
}

/** Base ambient env (guarded) + injected auth env merged on top (after the guard). */
export function buildChildEnv(auth: InjectedAuth): Record<string, string> {
  const env = cleanAmbientEnv();
  if (auth.env) Object.assign(env, auth.env);
  if (auth.gitSshCommand) env.GIT_SSH_COMMAND = auth.gitSshCommand;
  return env;
}

/**
 * simple-git blocks GIT_SSH_COMMAND / credential.helper / env-config-count as
 * "unsafe" by default. When (and only when) WE inject them (platform-generated,
 * never ambient — ambient was stripped above) we opt in per-category.
 */
export function buildUnsafe(auth: InjectedAuth): SimpleGitOptions['unsafe'] {
  const unsafe: NonNullable<SimpleGitOptions['unsafe']> = {};
  if (auth.gitSshCommand) unsafe.allowUnsafeSshCommand = true;
  if (auth.env && auth.env.GIT_CONFIG_COUNT) {
    unsafe.allowUnsafeConfigEnvCount = true;
    unsafe.allowUnsafeCredentialHelper = true;
  }
  return unsafe;
}
