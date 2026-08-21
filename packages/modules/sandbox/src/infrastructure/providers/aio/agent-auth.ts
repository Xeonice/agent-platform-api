import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';

/**
 * Per-sandbox credential for the in-sandbox AIO agent (SANDBOX-RUNTIME-DECISIONS
 * 「安全姿态」加固 1).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The agent's `:8080` is published on the HOST loopback (both providers — see the
 * ADR for why a shared docker network is not available in the single-host form).
 * `127.0.0.1` stops other MACHINES, not other LOCAL processes: any process on the
 * box (a package postinstall, any tool running as the same or another user) could
 * scan loopback and `POST /v1/bash/exec` — an unauthenticated shell inside the
 * sandbox, bypassing every platform Guard. This module closes that path.
 *
 * ── Why a JWT (探明 2026-08, 实测真镜像 `ghcr.io/agent-infra/sandbox:latest`) ──
 * The agent has NATIVE auth; it is simply OFF by default. Its entrypoint
 * (`/opt/gem/entrypoint.sh`) switches the nginx front door between
 * `nginx-server-without-auth.conf` and `nginx-server-with-auth.conf` purely on
 * whether `JWT_PUBLIC_KEY` is set and non-blank. With auth on, every route except
 * `GET /v1/ping` goes through nginx `auth_request` → the agent's own
 * `GET /auth` (`gem/routers/auth.py`), which:
 *   - base64-DECODES `JWT_PUBLIC_KEY` into a PEM public key,
 *   - verifies `Authorization: Bearer <jwt>` with **RS256 only** (hard-coded
 *     `jwt_algorithms=["RS256"]`, no env override),
 *   - requires NO particular claim: `exp` is honoured if present, and `aud`/`iss`
 *     are never checked (so a token carrying `aud` would FAIL — we omit it).
 * Verified against the real image: no header ⇒ 401, wrong key ⇒ 401, our token ⇒ 200.
 *
 * ── Why the private key is thrown away ───────────────────────────────────────
 * The keypair exists only to mint ONE token. The public half lives in the
 * sandbox's env for the sandbox's whole life, so a claim-free token stays valid
 * exactly as long as the sandbox does — there is nothing to refresh, hence no
 * reason to keep (or persist) signing material. The token is the only secret that
 * survives this call, and it dies with the sandbox.
 *
 * ── Residual risk (honest boundary) ──────────────────────────────────────────
 * The token is persisted with the sandbox row, so a process running AS THE
 * PLATFORM USER can still read it out of `platform.db`. That process could
 * already read the Vault master key next to it, so this is not a new exposure —
 * but it does mean this hardening buys "no blind loopback scan, and no access
 * from OTHER local users", not "same-user isolation".
 */
export interface AgentAuthMaterial {
  /** value for the agent's `JWT_PUBLIC_KEY` env — base64 of the PEM SPKI key. */
  readonly publicKeyB64: string;
  /** `Authorization: Bearer <token>` the client presents on every agent call. */
  readonly token: string;
}

/** The env var the AIO image reads to turn its nginx auth gateway ON. */
export const AGENT_JWT_PUBLIC_KEY_ENV = 'JWT_PUBLIC_KEY';

/**
 * Mint a fresh keypair + the single RS256 token signed by it. The private key
 * never leaves this function.
 *
 * Claims are deliberately minimal — `sub` (which sandbox this token is for, for
 * forensics in the agent's logs) and `jti` (128 bits of entropy, so two sandboxes
 * never share a token string). No `exp`: a wall clock is not available here
 * (Date.now() is banned in infrastructure) and expiry would be a liveness bug,
 * not a security win — the token's real lifetime bound is the container's.
 */
export function createAgentAuthMaterial(sandboxId: string): AgentAuthMaterial {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: sandboxId, jti: randomBytes(16).toString('hex') }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey).toString('base64url');
  return {
    publicKeyB64: Buffer.from(publicKey, 'utf8').toString('base64'),
    token: `${header}.${payload}.${signature}`,
  };
}

/**
 * Merge the agent's public key into the sandbox env. Ours WINS over a caller-set
 * value on purpose: a context that could override `JWT_PUBLIC_KEY` could disable
 * the gateway (blank value ⇒ the image activates the auth-free config).
 */
export function withAgentAuthEnv(
  env: Record<string, string>,
  material: AgentAuthMaterial,
): Record<string, string> {
  return { ...env, [AGENT_JWT_PUBLIC_KEY_ENV]: material.publicKeyB64 };
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** `Authorization` header for an agent request, or nothing when no token exists. */
export function authHeader(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

/**
 * Readiness-time proof that the gateway is actually GUARDING the port — the only
 * check that catches the failure mode this hardening exists to prevent: an image
 * that ignores `JWT_PUBLIC_KEY` would serve us happily while still answering every
 * other local process, and the platform would never notice. So an ANONYMOUS
 * request must be refused; if it is not, the sandbox fails LOUD at `start()`
 * rather than running as an open shell.
 *
 * A no-token sandbox (bare/legacy image) has nothing to assert — skipped.
 */
export async function assertAgentRejectsAnonymous(
  base: string,
  token: string | undefined,
): Promise<void> {
  if (token === undefined) return;
  const res = await fetch(`${base}/`, { method: 'GET' });
  if (res.status < 400) {
    throw new SandboxProviderError(
      SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
      `in-sandbox agent at ${base} answered an UNAUTHENTICATED request (HTTP ${res.status}) ` +
        `even though ${AGENT_JWT_PUBLIC_KEY_ENV} was injected — this image does not enforce ` +
        'the agent auth gateway, so its loopback-published port would be an open shell for ' +
        'every local process. Refusing to run (SANDBOX-RUNTIME-DECISIONS 安全姿态).',
    );
  }
}
