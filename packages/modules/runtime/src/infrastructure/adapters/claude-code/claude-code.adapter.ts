import { Injectable } from '@nestjs/common';
import type {
  ApiKeyFormatVerdict,
  AuthChallenge,
  AuthCompletionInput,
  AuthSessionContext,
  RuntimeAdapter,
  RuntimeAuthMethod,
  RuntimeCredential,
  SandboxExecFn,
} from '@platform/contracts';
import {
  validateAnthropicApiKey,
  validateClaudeOauthToken,
} from '../../../domain/services/token-format.validator';
import { AdapterAuthError } from '../../../domain/errors/adapter-auth.error';
import { readUntil } from '../pty-reader.util';
import { parseClaudeAuthUrl, parseClaudeSetupToken } from './claude-code.output-parser';

const BEGIN_TIMEOUT_MS = 60_000;
const COMPLETE_TIMEOUT_MS = 5 * 60_000;

/**
 * Claude Code RuntimeAdapter (docs/backend/04 §3, 05 §1 ★1). Account login =
 * `setup-token`: the auth URL is hidden in an OSC-8 escape (parse it, don't grep),
 * the user authorizes, and the 1-year token (`sk-ant-oat01-…`) is printed to stdout
 * FOLDED across lines → reconstruct + validate PREFIX/LENGTH/CHARSET before storing
 * (P1-4c). Injection = `CLAUDE_CODE_OAUTH_TOKEN` env (applied at sandbox start).
 */
@Injectable()
export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly vendor = 'Anthropic';

  getAuthMethods(): RuntimeAuthMethod[] {
    return ['setup-token', 'api-key'];
  }

  /** Anthropic api-key FORMAT check (`sk-ant-…`), owned by the adapter (05 §3.1). */
  validateApiKey(secret: string): ApiKeyFormatVerdict {
    return validateAnthropicApiKey(secret);
  }

  loginCommand(method: RuntimeAuthMethod): string[] {
    if (method === 'setup-token') return ['claude', 'setup-token'];
    throw new AdapterAuthError(
      'UNSUPPORTED_METHOD',
      `claude has no interactive login for ${method}`,
    );
  }

  async beginAuth(method: RuntimeAuthMethod, ctx: AuthSessionContext): Promise<AuthChallenge> {
    if (method !== 'setup-token') {
      throw new AdapterAuthError('UNSUPPORTED_METHOD', `claude beginAuth: ${method}`);
    }
    const url = await readUntil(ctx.pty, (s) => parseClaudeAuthUrl(s), BEGIN_TIMEOUT_MS);
    return {
      challengeRef: ctx.challengeRef,
      method: 'setup-token',
      kind: 'paste-prompt',
      verificationUrl: url,
      instructions: '在浏览器打开链接完成 claude.ai 授权，然后把页面给出的授权码粘贴回来提交。',
    };
  }

  async completeAuth(
    _challenge: AuthChallenge,
    input: AuthCompletionInput,
    ctx: AuthSessionContext,
  ): Promise<RuntimeCredential> {
    if (input.cancel) throw new AdapterAuthError('AUTH_REJECTED', 'login cancelled');
    if (!input.pastedText) {
      throw new AdapterAuthError('AUTH_REJECTED', 'setup-token requires pastedText');
    }
    // Feed the pasted authorization code into the CLI's stdin (never argv).
    ctx.pty.write(`${input.pastedText.trim()}\n`);
    const token = await readUntil(ctx.pty, (s) => parseClaudeSetupToken(s), COMPLETE_TIMEOUT_MS);
    // 入库前 PREFIX+LENGTH+CHARSET 校验 (P1-4c): a fold-mangled token is rejected here,
    // never silently stored.
    const verdict = validateClaudeOauthToken(token);
    if (!verdict.ok) {
      throw new AdapterAuthError('AUTH_REJECTED', `invalid setup-token: ${verdict.reason}`);
    }
    const clean = token.trim();
    const cred: RuntimeCredential = {
      runtimeId: 'claude-code',
      obtainedVia: 'setup-token',
      maskedIdentifier: `sk-ant-oat01-…${clean.slice(-4)}`,
      issuedAt: '',
      env: { CLAUDE_CODE_OAUTH_TOKEN: clean },
      credentialFiles: [],
      zeroize(): void {
        cred.env = undefined;
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
        `claude createCredentialFromSecret: ${method}`,
      );
    }
    const key = secret.trim();
    const cred: RuntimeCredential = {
      runtimeId: 'claude-code',
      obtainedVia: 'api-key',
      maskedIdentifier: `sk-…${key.slice(-4)}`,
      issuedAt: '',
      env: { ANTHROPIC_API_KEY: key },
      credentialFiles: [],
      zeroize(): void {
        cred.env = undefined;
      },
    };
    return cred;
  }

  /** claude injects via `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` env at sandbox
   *  start — no file, no argv, no exec needed here (05 §4). */
  async injectCredential(cred: RuntimeCredential, _exec: SandboxExecFn): Promise<void> {
    if (!cred.env || Object.keys(cred.env).length === 0) {
      throw new AdapterAuthError('AUTH_REJECTED', 'no injectable claude credential material');
    }
    // env is applied at sandbox START by the orchestration; nothing to exec.
    return;
  }
}
