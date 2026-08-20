import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import type {
  ApiKeyFormatVerdict,
  AuthChallenge,
  AuthCompletionInput,
  AuthSessionContext,
  RuntimeAdapter,
  RuntimeAuthMethod,
  RuntimeCredential,
  RuntimeRefreshCapability,
  SandboxExecFn,
} from '@platform/contracts';
import { AdapterAuthError } from '../../../domain/errors/adapter-auth.error';
import { validateOpenAiApiKey } from '../../../domain/services/token-format.validator';
import { readUntil } from '../pty-reader.util';
import {
  codexLoginSucceeded,
  parseCodexAuthJson,
  parseCodexDeviceChallenge,
} from './codex.output-parser';

const BEGIN_TIMEOUT_MS = 60_000;
const COMPLETE_TIMEOUT_MS = 15 * 60_000;

/**
 * Codex RuntimeAdapter (docs/backend/04 §3, 05 §1 ★2). Account login = device-auth
 * (plain-text code + read `auth.json`); api-key = short-circuit. Injection obeys the
 * minimal-exposure priority: access-token-only via STDIN (`codex login
 * --with-access-token`) — the token never enters argv/env/files, and the whole
 * `auth.json` (with refresh_token) is NEVER injected (P0-3).
 */
@Injectable()
export class CodexAdapter implements RuntimeAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  readonly vendor = 'OpenAI';

  /**
   * Codex account credential = an hourly access token the CLI refreshes itself from a
   * seeded `auth.json` (05 §5.1). The scanner reads the probe command + parser here —
   * it no longer hard-codes `['codex','whoami']` / `parseCodexAuthJson`.
   */
  readonly refreshCapability: RuntimeRefreshCapability = {
    probeCommand: ['codex', 'whoami'],
    parseRefreshedAuth(raw: string): { accessToken: string } {
      const auth = parseCodexAuthJson(raw);
      const access = auth.tokens?.access_token;
      if (!access) throw new Error('refreshed auth.json missing access_token');
      return { accessToken: access };
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
    const cred: RuntimeCredential = {
      runtimeId: 'codex',
      obtainedVia: 'oauth-device',
      maskedIdentifier: masked,
      issuedAt: '',
      accessToken: access,
      authFile: raw, // platform-only (refresh scanner); NEVER injected
      credentialFiles: [],
      zeroize(): void {
        cred.accessToken = undefined;
        cred.authFile = undefined;
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
   * Inject via the lowest-exposure channel. Account: the short-lived access token on
   * STDIN — never argv/env/files, and the refresh-token-bearing `authFile` is
   * deliberately ignored (P0-3). api-key: the env is applied at sandbox START by the
   * orchestration (05 §4.1 ④); nothing to exec here.
   */
  async injectCredential(cred: RuntimeCredential, exec: SandboxExecFn): Promise<void> {
    if (cred.accessToken && cred.accessToken.length > 0) {
      const r = await exec(['codex', 'login', '--with-access-token'], { stdin: cred.accessToken });
      if (r.exitCode !== 0) {
        throw new AdapterAuthError('AUTH_REJECTED', `codex --with-access-token exit ${r.exitCode}`);
      }
      return;
    }
    if (cred.env && Object.keys(cred.env).length > 0) return; // env applied at start
    throw new AdapterAuthError('AUTH_REJECTED', 'no injectable codex credential material');
  }
}
