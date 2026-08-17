import type { SimpleGitOptions } from 'simple-git';

/**
 * Shared git child-process hardening for the credential context (docs/backend/03
 * §7.3 F/G). Mirrors project's git-cloner guard: ambient unsafe git env is
 * stripped (incl. the GIT_TRACE* family so a host-set trace can't dump the
 * `Authorization:` header into stderr), then the platform-generated auth env is
 * merged AFTER the guard so the injected GIT_SSH_COMMAND / GIT_CONFIG_* survive.
 */
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
  // log-redaction (G): a host-set trace would print Authorization: Basic <PAT> to stderr.
  'GIT_TRACE',
  'GIT_TRACE_CURL',
  'GIT_CURL_VERBOSE',
  'GIT_TRACE_PACKET',
  // TLS is the HTTPS rebinding/MITM hard closure (03 §7.3 C4): a server on a rebound
  // internal IP cannot present a valid cert for the SNI/Host. Drop any ambient
  // GIT_SSL_NO_VERIFY so it can't silently disable that. (CAINFO/CAPATH are kept so
  // an internal CA for self-hosted git still works — user's own trust domain.)
  'GIT_SSL_NO_VERIFY',
]);

function cleanAmbientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (GUARDED_ENV.has(k.toUpperCase())) continue;
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
