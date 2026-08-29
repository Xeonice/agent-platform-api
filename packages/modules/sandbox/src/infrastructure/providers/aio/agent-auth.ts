import { randomBytes } from 'node:crypto';
import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';

/**
 * Per-sandbox credential for the in-sandbox AIO agent (SANDBOX-RUNTIME-DECISIONS
 * 「安全姿态」加固 1).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The agent's `:8080` is published on the HOST loopback. `127.0.0.1` stops other
 * MACHINES, not other LOCAL processes: any process on the box (a package
 * postinstall, any tool running as the same or another user) could scan loopback
 * and `POST /v1/bash/exec` — an unauthenticated shell inside the sandbox,
 * bypassing every platform Guard. This module closes that path.
 *
 * ══ 2026-08 迁移：自造 RS256 JWT → 镜像原生 `SANDBOX_API_KEY` ══════════════════
 *
 * 这里曾经是一整套自造凭证：`generateKeyPairSync('rsa')` 现场造一对密钥、手工拼
 * header/payload/signature 签一个 RS256 JWT、把公钥 base64 塞进 `JWT_PUBLIC_KEY`。
 * 它能用（实测过），但它是**我们自己维护的一套密码学代码**，换来的东西上游本来就白送。
 *
 * 实测 `ghcr.io/agent-infra/sandbox:latest`（v1.11.0，2026-08 复测）：镜像入口
 * `/opt/gem/gem.sh` 在选 nginx 配置时读的是**两个** env——
 *
 *   ```sh
 *   TRIMMED_JWT_PUBLIC_KEY="$(echo -n "$JWT_PUBLIC_KEY" | xargs)"
 *   TRIMMED_API_KEY="$(echo -n "${SANDBOX_API_KEY:-}" | xargs)"
 *   if [ -n "$TRIMMED_JWT_PUBLIC_KEY" ] || [ -n "$TRIMMED_API_KEY" ]; then  # 带鉴权
 *   ```
 *
 * 且它自己的安全提示把 `SANDBOX_API_KEY` 标成 **(recommended)**，JWT 排第二。
 * 两条路走的是同一扇 nginx `auth_request` 门、同一个 `GET /auth` 后端，因此鉴权
 * **强度相同**；差别只在我们这边要不要养一套签名代码。
 *
 * ⚠️ **凭证的形状变了，语义没变**：它仍然是一条 per-sandbox、与容器同生共死、
 * 无法从运行时反推的秘密，仍然随 `providerState` 落库（理由见 04 §7 / `agent-state.ts`：
 * 端口能从 `docker inspect` 重解，凭证不能——丢了就等于跨重启丢掉数据面）。
 *
 * ── 三种呈递方式，实测都通（v1.11.0）─────────────────────────────────────────
 * | 方式 | HTTP | WS upgrade |
 * |---|---|---|
 * | `X-AIO-API-Key: <key>` | 200 | 101 |
 * | `Authorization: Bearer <key>` | 200 | —（WHATWG WebSocket 带不了 header）|
 * | `?api_key=<key>` | 200 | 101 |
 * | 不带 / 带错 | 401 | 401 |
 *
 * 我们统一用 `X-AIO-API-Key`——它是镜像的**原生**头，`Authorization: Bearer` 在这里
 * 只是它的别名（这把钥匙不是 OAuth token，叫 Bearer 会让人以为它有 exp/aud）。
 *
 * ⚠️ **WS 仍然走 `POST /tickets` 换票，而不是 `?api_key=`**，尽管后者实测能开 101。
 * URL query 会进 nginx access log，而这把钥匙的寿命是**整个沙箱**；ticket 30 秒过期。
 * 用 query 等于把长期凭证写进沙箱自己的日志文件里——沙箱内的进程本来就读得到那份日志。
 *
 * ── Residual risk (honest boundary) ──────────────────────────────────────────
 * The key is persisted with the sandbox row, so a process running AS THE PLATFORM
 * USER can still read it out of `platform.db`. That process could already read the
 * Vault master key next to it, so this is not a new exposure — but it does mean
 * this hardening buys "no blind loopback scan, and no access from OTHER local
 * users", not "same-user isolation".
 */
export interface AgentAuthMaterial {
  /** value for the agent's `SANDBOX_API_KEY` env — turns its auth gateway ON. */
  readonly apiKey: string;
}

/** The env var the AIO image reads to turn its nginx auth gateway ON. */
export const AGENT_API_KEY_ENV = 'SANDBOX_API_KEY';

/**
 * The agent's own auth-FREE route (nginx `map` sends exactly `GET:/v1/ping` down
 * `@proxy_without_auth`, everything else through `auth_request`). It is the one
 * honest liveness probe: it answers 200 the moment the front door is up, WITHOUT
 * proving anything about the key — which is why readiness ALSO asserts an
 * authenticated call and an anonymous refusal (see `assertAgentRejectsAnonymous`).
 */
export const AGENT_PING_PATH = '/v1/ping';

/**
 * Mint the per-sandbox key. 256 bits of CSPRNG, base64url so it survives an env
 * var, a JSON column and a URL without escaping.
 *
 * ⚠️ **No `sandboxId` in the key.** The old JWT carried `sub: sandboxId` for
 * forensics; a shared secret is compared byte-for-byte by the agent, so anything
 * structured in it is not a claim — it is a hint to whoever steals it about which
 * sandbox it opens.
 */
export function createAgentAuthMaterial(): AgentAuthMaterial {
  return { apiKey: randomBytes(32).toString('base64url') };
}

/**
 * Merge the agent's key into the sandbox env. Ours WINS over a caller-set value on
 * purpose: a context that could override `SANDBOX_API_KEY` could blank it, and a
 * blank value makes the image activate its auth-FREE nginx config.
 *
 * ⚠️ `JWT_PUBLIC_KEY` is blanked in the same breath. The image turns auth on when
 * EITHER env is non-blank, so a caller-supplied public key would leave a SECOND
 * door open onto the same port — one whose private half we do not hold and cannot
 * revoke.
 */
export function withAgentAuthEnv(
  env: Record<string, string>,
  material: AgentAuthMaterial,
): Record<string, string> {
  return { ...env, JWT_PUBLIC_KEY: '', [AGENT_API_KEY_ENV]: material.apiKey };
}

/** The image's NATIVE auth header, or nothing when no key exists. */
export function authHeader(key: string | undefined): Record<string, string> {
  return key === undefined ? {} : { 'x-aio-api-key': key };
}

/**
 * Readiness-time proof that the gateway is actually GUARDING the port — the only
 * check that catches the failure mode this hardening exists to prevent: an image
 * that ignores `SANDBOX_API_KEY` would serve us happily while still answering every
 * other local process, and the platform would never notice. So an ANONYMOUS
 * request must be refused; if it is not, the sandbox fails LOUD at `start()`
 * rather than running as an open shell.
 *
 * ⚠️ The probe path must be an AUTHENTICATED one. `GET /v1/ping` is deliberately
 * exempt from `auth_request` in the image's own nginx map, so probing it anonymously
 * would return 200 on a perfectly guarded sandbox and this check would reject every
 * healthy image. `/` is guarded.
 *
 * A no-key sandbox (bare/legacy image) has nothing to assert — skipped.
 */
export async function assertAgentRejectsAnonymous(
  base: string,
  key: string | undefined,
): Promise<void> {
  if (key === undefined) return;
  const res = await fetch(`${base}/`, { method: 'GET' });
  if (res.status < 400) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
      `in-sandbox agent at ${base} answered an UNAUTHENTICATED request (HTTP ${res.status}) ` +
        `even though ${AGENT_API_KEY_ENV} was injected — this image does not enforce ` +
        'the agent auth gateway, so its loopback-published port would be an open shell for ' +
        'every local process. Refusing to run (SANDBOX-RUNTIME-DECISIONS 安全姿态).',
    );
  }
}

/**
 * ── 生存义务 (the `SandboxJobs` survival obligation, 04 §2.6 ★★★) ──────────────
 *
 * A provider that advertises `headlessTask` promises a job stays startable, readable
 * and killable for its whole `JobSpec.timeoutMs`. The backing agent BREAKS that
 * promise by default, in two independent ways (both measured 2026-08):
 *
 *   ① `BASH_SESSION_TIMEOUT` (default 3600s) reaps a session on IDLE — and the clock
 *      is refreshed by SUBMITTING a command, never by reading its output, and the
 *      reaper does not check whether the command is still running. So the 2h and 4h
 *      timeout tiers (P20 §0) would be destroyed mid-run, taking the output AND the
 *      exit code with them; the 1h tier sits exactly on the line. "Poll more often"
 *      is not a fix — polling does not touch the clock.
 *   ② `MAX_BASH_SESSIONS` (default 50) EVICTS THE OLDEST session when a new one is
 *      created, so a sandbox that runs many Tasks silently loses the early ones.
 *
 * Both are plain env ints read at agent boot ⇒ the fix is to set them at CREATE time,
 * through the very channel `SANDBOX_API_KEY` already uses. This is the whole reason
 * `create()` — not `startJob` — carries the obligation: by the time a job starts, the
 * agent has long since read its config.
 */
export const AGENT_SESSION_TTL_ENV = 'BASH_SESSION_TIMEOUT';
export const AGENT_MAX_SESSIONS_ENV = 'MAX_BASH_SESSIONS';

/**
 * Seconds. The longest tier a Task may ask for is 240 minutes (`TaskTimeoutMinutesSchema`),
 * so the ceiling is that plus enough slack to survive a platform restart and a slow
 * artifact collection before `releaseJob` — 24h, i.e. 6× the longest tier. It is a
 * ceiling on IDLE time inside a sandbox that the platform destroys anyway, not a
 * resource reservation, so buying margin here costs nothing.
 */
export const AGENT_SESSION_TTL_SECONDS = 24 * 60 * 60;
/** Enough Tasks per sandbox that eviction stops being a silent data-loss path. */
export const AGENT_MAX_SESSIONS = 512;

/**
 * Merge the survival settings into the sandbox env. Ours WIN over caller-set values
 * for the same reason `withAgentAuthEnv` does: a context that could lower these could
 * re-arm the exact failure the job plane exists to prevent.
 */
export function withJobSurvivalEnv(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    [AGENT_SESSION_TTL_ENV]: String(AGENT_SESSION_TTL_SECONDS),
    [AGENT_MAX_SESSIONS_ENV]: String(AGENT_MAX_SESSIONS),
  };
}
