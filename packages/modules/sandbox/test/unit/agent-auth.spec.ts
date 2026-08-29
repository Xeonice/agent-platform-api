import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';
import {
  AGENT_API_KEY_ENV,
  AGENT_PING_PATH,
  assertAgentRejectsAnonymous,
  authHeader,
  createAgentAuthMaterial,
  withAgentAuthEnv,
} from '../../src/infrastructure/providers/aio/agent-auth';

/**
 * The credential that closes the loopback-shell hole (ADR 安全姿态 加固 1), after the
 * 2026-08 migration from a self-minted RS256 JWT to the image's OWN
 * `SANDBOX_API_KEY`.
 *
 * ⚠️ **这个文件之前断言的是我们自己那套密码学**（PEM 前缀、`alg:RS256`、`sub`/`jti`
 * 声明、用公钥验签）。那些断言随被测代码一起作废了——留着它们只会把「我们不再自己
 * 签名了」这件事伪装成回归。现在它断言的是**新的那份秘密的性质**：够随机、不可猜、
 * 每个沙箱一把、以镜像原生的头呈递。活镜像上的证明在 aio-agent-auth.e2e-spec.ts。
 */
describe('agent auth material', () => {
  it('mints a high-entropy key that survives an env var / a URL unescaped', () => {
    const { apiKey } = createAgentAuthMaterial();
    // base64url of 32 bytes = 43 chars, alphabet [A-Za-z0-9_-] — no `=`, `+` or `/`,
    // so it needs no quoting in `KEY=value`, in JSON, or in a query string.
    expect(apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('mints an INDEPENDENT key per sandbox', () => {
    // 100 draws, all distinct: a per-sandbox credential that repeats is one sandbox's
    // key opening another's shell. (A constant would pass a 2-sample check often
    // enough to survive review; it cannot pass this one.)
    const keys = new Set(Array.from({ length: 100 }, () => createAgentAuthMaterial().apiKey));
    expect(keys.size).toBe(100);
  });

  it('does not encode the sandbox id into the key', () => {
    // the old JWT carried `sub: sandboxId` for forensics; a SHARED SECRET is compared
    // byte-for-byte, so structure in it is not a claim — it is a hint to whoever
    // steals it about which sandbox it opens.
    expect(createAgentAuthMaterial().apiKey).not.toContain('sbx');
  });

  it('overrides a caller-supplied SANDBOX_API_KEY instead of deferring to it', () => {
    // a blank/foreign value would switch the image back to its auth-FREE config,
    // so the platform's key has to win — this is a security rule, not a merge order.
    const material = createAgentAuthMaterial();
    const env = withAgentAuthEnv({ [AGENT_API_KEY_ENV]: '', OTHER: 'kept' }, material);
    expect(env[AGENT_API_KEY_ENV]).toBe(material.apiKey);
    expect(env.OTHER).toBe('kept');
  });

  it('blanks a caller-supplied JWT_PUBLIC_KEY — the image would honour it as a SECOND door', () => {
    // `gem.sh` turns auth on when EITHER env is non-blank, and each is checked
    // independently by the same `/auth` backend. A caller-set public key would open a
    // door onto the same port whose private half we do not hold and cannot revoke.
    const env = withAgentAuthEnv(
      { JWT_PUBLIC_KEY: 'c29tZWJvZHkgZWxzZQ==' },
      createAgentAuthMaterial(),
    );
    expect(env.JWT_PUBLIC_KEY).toBe('');
  });

  it("emits the image's NATIVE api-key header, only when a key exists", () => {
    expect(authHeader(undefined)).toEqual({});
    expect(authHeader('t')).toEqual({ 'x-aio-api-key': 't' });
  });
});

describe('anonymous-rejection readiness assertion', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  async function serve(status: number): Promise<string> {
    server = createServer((_req, res) => {
      res.writeHead(status);
      res.end();
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const addr = server.address();
    return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }

  it('refuses to run when the agent serves an UNAUTHENTICATED request', async () => {
    // the failure this exists to catch: an image that ignores SANDBOX_API_KEY would
    // answer us fine while staying an open shell for every other local process.
    const base = await serve(200);
    await expect(assertAgentRejectsAnonymous(base, 'k')).rejects.toMatchObject({
      code: SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
    });
    await expect(assertAgentRejectsAnonymous(base, 'k')).rejects.toBeInstanceOf(
      SandboxProviderError,
    );
  });

  it('passes when the agent answers 401 to an anonymous request', async () => {
    await expect(assertAgentRejectsAnonymous(await serve(401), 'k')).resolves.toBeUndefined();
  });

  it('has nothing to assert for a key-less (agent-less/legacy) sandbox', async () => {
    await expect(assertAgentRejectsAnonymous(await serve(200), undefined)).resolves.toBeUndefined();
  });

  it('probes a GUARDED path — never the auth-exempt ping', async () => {
    // ⚠️ `GET /v1/ping` is the ONE route the image's nginx map sends down
    // `@proxy_without_auth`. Probing it anonymously returns 200 on a perfectly
    // guarded sandbox, so this assertion would reject every healthy image.
    let probed = '';
    server = createServer((req, res) => {
      probed = req.url ?? '';
      res.writeHead(401);
      res.end();
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    await assertAgentRejectsAnonymous(base, 'k');
    expect(probed).not.toBe(AGENT_PING_PATH);
  });
});
