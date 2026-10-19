import type { ReadableStreamReadResult } from 'node:stream/web';
import { HttpException, HttpStatus } from '@nestjs/common';
import { z } from 'zod';
import type { Request } from 'express';
import { readPublicNetworkConfig } from '../config/public-network';
import { requestClientIp } from './client-ip';
import { presentedAccessPasscode } from './session-cookie';
import { passcodeInvalid, passcodeLocked, passcodeRequired } from './passcode-errors';

const Source = z.enum(['none', 'stored', 'env']);
export const AuthorityStatusSchema = z
  .object({
    enabled: z.boolean(),
    source: Source,
    envOverride: z.boolean(),
    sessionSecretPinned: z.boolean(),
    revision: z.number().int().positive(),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict()
  .refine(
    (s) =>
      s.enabled === (s.source !== 'none') &&
      s.envOverride === (s.source === 'env') &&
      (s.source === 'stored' || s.updatedAt === null),
  );
export type AuthorityStatus = z.infer<typeof AuthorityStatusSchema>;
export const AuthorityRequestSchema = z
  .object({
    remoteAddress: z.string().max(128).nullable(),
    clientIp: z.string().max(128),
    cookie: z.string().max(8192).optional(),
    passcode: z.string().max(1024).optional(),
  })
  .strict();
export type AuthorityRequest = z.infer<typeof AuthorityRequestSchema>;
export const AuthorityPrincipalSchema = z
  .object({
    actorId: z.string().max(256),
    viewerId: z.string().max(200),
    canUpgrade: z.boolean(),
    userScope: z.string().regex(/^[a-f0-9]{64}$/),
    csrfToken: z.string().max(128),
  })
  .strict();
export const AuthorityDecisionSchema = z
  .object({
    authorized: z.boolean(),
    policyRevision: z.number().int().positive(),
    status: AuthorityStatusSchema,
    sessionToken: z.string().max(256).optional(),
    principal: AuthorityPrincipalSchema.optional(),
    viewerCookie: z.string().max(8192).optional(),
    failure: z
      .object({
        kind: z.enum(['required', 'invalid', 'locked']),
        retryAfterSec: z.number().int().positive().optional(),
        consecutiveFailures: z.number().int().nonnegative().optional(),
        maxFailures: z.literal(5).optional(),
        lockedForSec: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.policyRevision === v.status.revision &&
      (v.authorized ? v.failure === undefined : v.failure !== undefined) &&
      (!v.principal || v.principal.canUpgrade === v.authorized),
  );
export type AuthorityDecision = z.infer<typeof AuthorityDecisionSchema>;
export const AuthorityFingerprintSchema = z
  .object({
    instanceId: z.string().max(200),
    policyRevision: z.number().int().positive(),
    fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    legacyFingerprint: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
export const AuthorityChallengeSchema = AuthorityFingerprintSchema.extend({
  cookie: z.string().max(8192),
  userScope: z.string().regex(/^[a-f0-9]{64}$/),
  legacy: z.boolean(),
  sessionToken: z.string().max(256),
}).strict();
export const AuthorityChangeSchema = z
  .object({
    result: z.object({ enabled: z.boolean(), passcode: z.string().length(16).optional() }).strict(),
    status: AuthorityStatusSchema,
    changed: z.boolean(),
    sessionToken: z.string().max(256).optional(),
  })
  .strict();
export type AuthorityChange = z.infer<typeof AuthorityChangeSchema>;
export interface AuthorityAction {
  action: 'enable' | 'regenerate' | 'disable';
  invalidateSessions?: boolean;
}

export function authorityRequest(req: Request, plain?: string): AuthorityRequest {
  const passcode = plain ?? presentedAccessPasscode(req);
  return AuthorityRequestSchema.parse({
    remoteAddress: req.socket.remoteAddress ?? null,
    clientIp: requestClientIp(req, readPublicNetworkConfig()),
    ...(typeof req.headers.cookie === 'string' ? { cookie: req.headers.cookie } : {}),
    ...(passcode !== undefined ? { passcode } : {}),
  });
}
export function requireAuthorityDecision(value: AuthorityDecision): void {
  if (value.authorized) return;
  if (value.failure?.kind === 'locked' && value.failure.retryAfterSec)
    throw passcodeLocked(value.failure.retryAfterSec);
  if (value.failure?.kind === 'invalid') throw passcodeInvalid();
  throw passcodeRequired();
}
function unavailable(sideEffectFree: boolean): HttpException {
  return new HttpException(
    {
      code: 'ACCESS_AUTHORITY_UNAVAILABLE',
      message: '访问验证暂时不可用，请稍后重试',
      retryable: true,
      sideEffectFree,
    },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

/** Private loopback-only RPC. No retries, credentials in RAM only, one 2s total deadline. */
export function createAccessAuthorityClient({
  origin,
  key,
  instanceId,
  fetcher = fetch,
}: {
  origin: string;
  key: string;
  instanceId: string;
  fetcher?: typeof fetch;
}) {
  const url = new URL(origin);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    key.length < 32 ||
    !/^[a-zA-Z0-9._:-]{1,200}$/.test(instanceId)
  )
    throw unavailable(true);
  async function call<T>(action: string, body: object, schema: z.ZodType<T>): Promise<T> {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > 16384) throw unavailable(true);
    try {
      const response = await fetcher(url.origin + '/internal/control/access/' + action, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-platform-internal-key': key,
          'x-platform-instance-id': instanceId,
        },
        body: encoded,
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!response.body) throw unavailable(action !== 'change');
      const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
      try {
        for (;;) {
          const next: ReadableStreamReadResult<Uint8Array> = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 16384) {
            await reader.cancel();
            throw unavailable(action !== 'change');
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) {
        const failure = z
          .object({
            error: z
              .object({
                code: z.string().regex(/^[A-Z0-9_]{1,100}$/),
                message: z.string().max(512),
              })
              .strict(),
          })
          .strict()
          .safeParse(raw);
        if (action === 'change' && response.status === 409 && failure.success)
          throw new HttpException(
            {
              code: 'INVALID_STATE',
              message: failure.data.error.message,
              retryable: false,
              sideEffectFree: true,
            },
            HttpStatus.CONFLICT,
          );
        if (response.status === 401) throw passcodeRequired();
        throw unavailable(action !== 'change');
      }
      return schema.parse(raw);
    } catch (failure) {
      if (failure instanceof HttpException) throw failure;
      throw unavailable(action !== 'change');
    }
  }
  return {
    status: () => call('status', {}, AuthorityStatusSchema),
    authenticate: (request: AuthorityRequest, mode: 'http' | 'ws' | 'read-only' = 'http') =>
      call('authenticate', { request, mode }, AuthorityDecisionSchema),
    unlock: (request: AuthorityRequest) => call('unlock', { request }, AuthorityDecisionSchema),
    change: (request: AuthorityRequest, input: AuthorityAction) =>
      call('change', { request, ...input }, AuthorityChangeSchema),
    fingerprint: () => call('fingerprint', {}, AuthorityFingerprintSchema),
    challenge: (legacyBaseline: boolean) =>
      call('challenge', { legacyBaseline }, AuthorityChallengeSchema),
  };
}
export type AccessAuthorityClient = ReturnType<typeof createAccessAuthorityClient>;
