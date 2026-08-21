import { createVerify } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxProviderError, SandboxProviderErrorCode } from '@platform/contracts';
import {
  AGENT_JWT_PUBLIC_KEY_ENV,
  assertAgentRejectsAnonymous,
  authHeader,
  createAgentAuthMaterial,
  withAgentAuthEnv,
} from '../../src/infrastructure/providers/aio/agent-auth';

/**
 * The credential that closes the loopback-shell hole (ADR 安全姿态 加固 1).
 *
 * What matters here is that the two halves MATCH: the base64 PEM handed to the
 * sandbox as `JWT_PUBLIC_KEY` must be exactly the key that verifies the token the
 * platform will present. The agent verifies with RS256 and nothing else, so a
 * silent algorithm/encoding drift would hand every caller a 401 (or, worse, make
 * us ship a token the agent never checks). The live-image proof is
 * aio-agent-auth.e2e-spec.ts; this pins the wire shape without a container.
 */
function splitJwt(token: string): { signingInput: string; header: Record<string, unknown> } {
  const parts = token.split('.');
  expect(parts).toHaveLength(3);
  return {
    signingInput: `${parts[0]}.${parts[1]}`,
    header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >,
  };
}

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

describe('agent auth material', () => {
  it('signs an RS256 JWT that the injected public key verifies', () => {
    const material = createAgentAuthMaterial('sbx-42');
    const pem = Buffer.from(material.publicKeyB64, 'base64').toString('utf8');
    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----/);

    const { signingInput, header } = splitJwt(material.token);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput);
    const signature = Buffer.from(material.token.split('.')[2], 'base64url');
    expect(verifier.verify(pem, signature)).toBe(true);
  });

  it('carries only claims the agent tolerates — sub + jti, no aud/exp', () => {
    // the agent's validator never passes an `audience`, so a token carrying `aud`
    // is REJECTED by PyJWT; and it has no clock we can agree with, so `exp` would
    // only ever be a liveness bug. Keep the payload boring on purpose.
    const payload = payloadOf(createAgentAuthMaterial('sbx-7').token);
    expect(payload.sub).toBe('sbx-7');
    expect(payload.jti).toMatch(/^[0-9a-f]{32}$/);
    expect(payload).not.toHaveProperty('aud');
    expect(payload).not.toHaveProperty('exp');
  });

  it('mints an independent credential per sandbox', () => {
    const a = createAgentAuthMaterial('sbx-a');
    const b = createAgentAuthMaterial('sbx-b');
    expect(a.token).not.toBe(b.token);
    expect(a.publicKeyB64).not.toBe(b.publicKeyB64);

    // and one sandbox's token must NOT verify under the other's key
    const { signingInput } = splitJwt(a.token);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput);
    expect(
      verifier.verify(
        Buffer.from(b.publicKeyB64, 'base64').toString('utf8'),
        Buffer.from(a.token.split('.')[2], 'base64url'),
      ),
    ).toBe(false);
  });

  it('overrides a caller-supplied JWT_PUBLIC_KEY instead of deferring to it', () => {
    // a blank/foreign value would switch the image back to its auth-FREE config,
    // so the platform's key has to win — this is a security rule, not a merge order.
    const material = createAgentAuthMaterial('sbx-1');
    const env = withAgentAuthEnv({ [AGENT_JWT_PUBLIC_KEY_ENV]: '', OTHER: 'kept' }, material);
    expect(env[AGENT_JWT_PUBLIC_KEY_ENV]).toBe(material.publicKeyB64);
    expect(env.OTHER).toBe('kept');
  });

  it('emits a bearer header only when a token exists', () => {
    expect(authHeader(undefined)).toEqual({});
    expect(authHeader('t')).toEqual({ authorization: 'Bearer t' });
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
    // the failure this exists to catch: an image that ignores JWT_PUBLIC_KEY would
    // answer us fine while staying an open shell for every other local process.
    const base = await serve(200);
    await expect(assertAgentRejectsAnonymous(base, 'tok')).rejects.toMatchObject({
      code: SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
    });
    await expect(assertAgentRejectsAnonymous(base, 'tok')).rejects.toBeInstanceOf(
      SandboxProviderError,
    );
  });

  it('passes when the agent answers 401 to an anonymous request', async () => {
    await expect(assertAgentRejectsAnonymous(await serve(401), 'tok')).resolves.toBeUndefined();
  });

  it('has nothing to assert for a token-less (agent-less/legacy) sandbox', async () => {
    await expect(assertAgentRejectsAnonymous(await serve(200), undefined)).resolves.toBeUndefined();
  });
});
