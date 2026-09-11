import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { CLOCK, EVENT_BUS, ID_GENERATOR, UNIT_OF_WORK, shiftMs } from '@platform/shared-kernel';
import type { Clock, EventBus, IdGenerator, UnitOfWork } from '@platform/shared-kernel';
import { RUNTIME_ADAPTER_REGISTRY, adapterAuthErrorCodeOf } from '@platform/contracts';
import type {
  AuthChallengeDto,
  RuntimeAdapter,
  RuntimeAdapterRegistry,
  RuntimeAuthMethod,
  RuntimeAuthMode,
  RuntimeCredential,
  RuntimeDto,
  RuntimeSecretMethod,
  RuntimeSettingsDto,
} from '@platform/contracts';
import { RuntimeCredentialService } from '@platform/credential';
import type { RuntimeSecretPayload } from '@platform/credential';
import { AUTH_HELPER } from '../domain/ports/auth-helper.port';
import type { AuthHelper, AuthHelperSession } from '../domain/ports/auth-helper.port';
import { AuthSessionStore } from './auth-session.store';
import type { AuthOutcomeStatus } from './auth-session.store';
import { AuthChallenge } from '../domain/value-objects/auth-challenge.vo';
import { RuntimeSettings } from '../domain/entities/runtime-settings.entity';
import {
  AuthMethodPolicy,
  UnsupportedAuthMethodError,
} from '../domain/services/auth-method.policy';
import { RUNTIME_SETTINGS_REPOSITORY } from '../domain/repositories/runtime-settings.repository';
import type { RuntimeSettingsRepository } from '../domain/repositories/runtime-settings.repository';

/**
 * Device-code challenge lifetime (05 §1 ★2: 15min). This one IS a platform constant —
 * it bounds the platform's own in-memory AuthSession, not any vendor's token.
 *
 * The per-credential lifetimes that used to live here (codex hourly / claude ~1yr) are
 * VENDOR facts and now come from `RuntimeAdapter.credentialTtlMs` (04 §3): keying them
 * off the auth METHOD in this layer silently gave any third-party runtime that uses
 * `oauth-device` the Codex hour.
 */
const DEVICE_CODE_TTL_MS = 15 * 60_000;

@Injectable()
export class RuntimeApplicationService {
  private readonly logger = new Logger('RuntimeApplicationService');

  constructor(
    @Inject(RUNTIME_ADAPTER_REGISTRY) private readonly registry: RuntimeAdapterRegistry,
    @Inject(AUTH_HELPER) private readonly helper: AuthHelper,
    @Inject(RUNTIME_SETTINGS_REPOSITORY) private readonly settings: RuntimeSettingsRepository,
    private readonly sessions: AuthSessionStore,
    private readonly credentials: RuntimeCredentialService,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  /** GET /api/runtimes — aggregate rows with credential status (27 §4, no N+1). */
  async listRuntimes(): Promise<RuntimeDto[]> {
    return Promise.all(this.registry.list().map((a) => this.toRuntimeDto(a)));
  }

  async getCredentialStatus(runtimeId: string): Promise<RuntimeDto> {
    return this.toRuntimeDto(this.adapter(runtimeId));
  }

  private async toRuntimeDto(adapter: RuntimeAdapter): Promise<RuntimeDto> {
    const settings = await this.settings.findByRuntime(adapter.id);
    const mode = settings?.activeAuthMethod ?? null;
    const [view, credentials] = await Promise.all([
      this.credentials.view(adapter.id, mode),
      this.credentials.listSummaries(adapter.id),
    ]);
    // ⛔ NO FILTER. This line used to be
    //    `.filter((m) => m !== 'access-token-paste')` — the application layer deleting a
    //    method the adapter had just declared, because the DTO schema could not express
    //    it. An adapter offering only that method reached the UI as `authMethods: []`
    //    and rendered as 「没有可用的配置方式」 for a runtime that is fully configurable
    //    (04 §8 ★8a 末). The wire type is now the whole closed set, so the platform
    //    simply reports what was declared.
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      vendor: adapter.vendor,
      authMethods: adapter.getAuthMethods(),
      // Advisory only — the authoritative format check is `validateApiKey`, server-side.
      apiKeyPrefix: adapter.apiKeyPrefix,
      credentialStatus: view.credentialStatus,
      maskedIdentifier: view.maskedIdentifier,
      expiresAt: view.expiresAt,
      activeAuthMethod: mode ?? undefined,
      // per-mode parallel cards (P21-3 §3); each row carries its own credentialId
      credentials,
    };
  }

  /** POST .../auth/begin — start the login in the auth helper (05 §3). */
  async beginAuth(runtimeId: string, method: RuntimeAuthMethod): Promise<AuthChallengeDto> {
    const adapter = this.adapter(runtimeId);
    try {
      AuthMethodPolicy.assertSupported(method, adapter.getAuthMethods());
    } catch (e) {
      if (e instanceof UnsupportedAuthMethodError) throw unsupportedMethod(e);
      throw e;
    }
    const challengeRef = this.ids.next();
    const deviceCodeExpiresAt = shiftMs(this.clock.now(), DEVICE_CODE_TTL_MS).toISOString();

    let session: AuthHelperSession;
    try {
      // The helper points HOME **and every name this runtime declares** at the fresh
      // throw-away directory (04 §3 ★3z). Declaring none = "this CLI honours HOME
      // alone", which is a valid answer, not an omission.
      session = await this.helper.openSession(
        adapter.loginCommand(method),
        undefined,
        adapter.configDirEnvNames,
      );
    } catch (e) {
      // ⛔ 以前这里是 `ServiceUnavailableException('auth helper unavailable: … (PROVIDER_UNAVAILABLE)')`：
      //    码被**拼进散文**，而信封里的 `code` 是 `codeForStatus(503)` 算出来的 `INTERNAL` ——
      //    同一个响应，正文说 PROVIDER_UNAVAILABLE、`code` 位写 INTERNAL，互相矛盾。
      //    `access-passcode/access-audit.ts` 的注释明令禁止把码拼进散文；runtime 侧曾有三处这么干。
      // ⇒ 码归 code 位，原始技术细节归 details，message 只留人话。
      throw new ServiceUnavailableException({
        code: 'PROVIDER_UNAVAILABLE',
        message: '本机的登录程序没能启动，暂时没法开始登录。',
        retryable: true,
        // 门口就失败了：`openSession` 抛错时什么都没建起来（下面的 `sessions.put` 还没走到）。
        sideEffectFree: true,
        details: [{ code: 'HELPER_SESSION_OPEN_FAILED', message: (e as Error).message }],
      });
    }

    try {
      const raw = await adapter.beginAuth(method, {
        pty: session.pty,
        homeDir: session.homeDir,
        challengeRef,
        deviceCodeExpiresAt: method === 'oauth-device' ? deviceCodeExpiresAt : undefined,
      });
      const challenge = AuthChallenge.create(raw);
      const expiresAt = shiftMs(this.clock.now(), DEVICE_CODE_TTL_MS);
      this.sessions.put({
        challengeRef,
        runtimeId,
        session,
        challenge,
        expiresAt,
        status: 'pending',
      });
      // device-code flow completes asynchronously (the user authorizes in a browser);
      // drive completion in the background so `pollAuthStatus` can report success.
      if (challenge.kind === 'device-code') {
        void this.awaitDeviceCompletion(runtimeId, challengeRef);
      } else if (adapter.awaitSelfCompletion !== undefined) {
        // ⭐ **CLI 自己就能完成时，也要有人接着**（2026-09-07 真机补）。
        //    `claude setup-token` 起了一个本地监听，浏览器授权后回调页把码**直接送进
        //    那个端口**，页面显示「成功，可以关闭此窗口」—— 同机流程下根本不显示码。
        //    此前平台只等 `completeAuth(pastedText)`：码送到了、CLI 拿到 token 了，
        //    而平台在等一个永远不会有的粘贴，用户看着浏览器说成功、这边一直转圈。
        //
        // ⚠️ 粘贴那条路照留 —— 浏览器与 helper 不在同一台机器时（真远端部署），回调页
        //    够不到本地端口，才会退化成显示码。**两条路谁先到算谁**（见 finishChallenge）。
        void this.awaitSelfCompletion(runtimeId, challengeRef);
      }
      return challenge.toDto();
    } catch (e) {
      await session.dispose();
      throw this.mapAdapterError(e);
    }
  }

  /** GET .../auth/status?challengeRef= — device-code poll (05 §3). */
  async pollAuthStatus(
    runtimeId: string,
    challengeRef: string,
  ): Promise<{ status: 'pending' | 'success' | 'expired' | 'error'; maskedIdentifier?: string }> {
    const now = this.clock.now();
    const entry = this.sessions.get(challengeRef);
    if (entry && entry.runtimeId === runtimeId) {
      // still live: a pending challenge past its TTL reads as `expired`.
      if (entry.status === 'pending' && entry.expiresAt.getTime() <= now.getTime()) {
        return { status: 'expired' };
      }
      return { status: entry.status, maskedIdentifier: entry.maskedIdentifier };
    }
    // The live entry is gone — a settled device-code login leaves a terminal tombstone
    // (success/error/expired) so the frontend's next poll still sees a TRUE terminal
    // state instead of a bare 404 (P2; the frontend's assumed-dead fix depends on this).
    const outcome = this.sessions.outcome(challengeRef, now);
    if (outcome && outcome.runtimeId === runtimeId) {
      return { status: outcome.status, maskedIdentifier: outcome.maskedIdentifier };
    }
    throw new NotFoundException(`unknown challengeRef ${challengeRef}`);
  }

  /** POST .../auth/complete — setup-token paste (05 §3). */
  async completeAuth(
    runtimeId: string,
    challengeRef: string,
    pastedText?: string,
  ): Promise<{ maskedIdentifier: string }> {
    const entry = this.sessions.getLive(challengeRef, this.clock.now());
    if (!entry || entry.runtimeId !== runtimeId) {
      throw new NotFoundException(`challenge ${challengeRef} expired or unknown`);
    }
    const adapter = this.adapter(runtimeId);
    try {
      const cred = await adapter.completeAuth(
        entry.challenge.toDto(),
        { pastedText },
        {
          pty: entry.session.pty,
          homeDir: entry.session.homeDir,
          challengeRef,
          deviceCodeExpiresAt: entry.challenge.expiresAt,
        },
      );
      // ⚠️ **走同一个出口**：后台可能有一条「CLI 自完成」也在等同一个 PTY 上的 token，
      //    两条都会成功。`finishChallenge` 用「live entry 还在不在」当锁，保证只落库一次。
      const masked = await this.finishChallenge(runtimeId, challengeRef, cred);
      if (masked !== null) return { maskedIdentifier: masked };
      // 自完成先到了 —— 凭证已经存好，把它的结果原样报回去，⛔ 不要再存一遍。
      const settled = this.sessions.outcome(challengeRef, this.clock.now());
      if (settled?.maskedIdentifier !== undefined) {
        return { maskedIdentifier: settled.maskedIdentifier };
      }
      throw new NotFoundException(`challenge ${challengeRef} expired or unknown`);
    } catch (e) {
      const live = this.sessions.get(challengeRef);
      if (live) {
        live.status = 'error';
        await live.session.dispose();
        this.sessions.delete(challengeRef);
      }
      throw this.mapAdapterError(e);
    }
  }

  /** Background completion for device-code logins. */
  /**
   * 正在结算中的挑战 —— 两条完成路径撞车时，输的那条 await 赢家这一份。
   *
   * ⚠️ 只在「已占锁、尚未 settle」那段窗口里有值；settle 之后墓碑就是权威。
   */
  private readonly settling = new Map<string, Promise<string>>();

  /**
   * 后台守着「CLI 自己完成」那条路 —— 成功就直接落库，用户什么都不用做。
   *
   * ⚠️ **失败不打扰用户**：走不到这条路是**正常**的（远端部署下回调页够不到本机监听，
   * 那时正确的做法就是显示码让人粘贴）。所以超时/出错只留一条 debug，⛔ 不 settle、
   * 不报错 —— settle 会把粘贴那条路一起掐掉，而那条路此刻可能正等着用户操作。
   */
  private async awaitSelfCompletion(runtimeId: string, challengeRef: string): Promise<void> {
    const entry = this.sessions.get(challengeRef);
    if (!entry) return;
    const adapter = this.adapter(runtimeId);
    if (adapter.awaitSelfCompletion === undefined) return;
    try {
      const cred = await adapter.awaitSelfCompletion(entry.challenge.toDto(), {
        pty: entry.session.pty,
        homeDir: entry.session.homeDir,
        challengeRef,
        deviceCodeExpiresAt: entry.challenge.expiresAt,
      });
      await this.finishChallenge(runtimeId, challengeRef, cred);
    } catch (e) {
      this.logger.debug?.(
        `self-completion for ${challengeRef} did not happen (${(e as Error).message}) —— ` +
          '正常情况：浏览器与 helper 不在同一台机器时，用户会走粘贴那条路',
      );
    }
  }

  /**
   * 把一次成功的登录**落库并结算** —— 两条完成路径（用户粘贴 / CLI 自完成）的**唯一出口**。
   *
   * ⛔ 必须只发生一次：两条路同时在等同一个 PTY 上的 token，都会成功。这里用「live entry
   * 还在不在」当那把锁 —— `settle` 会把它换成墓碑，于是后到的那条自然什么也不做。
   */
  private async finishChallenge(
    runtimeId: string,
    challengeRef: string,
    cred: RuntimeCredential,
  ): Promise<string | null> {
    // ⛔ **锁要在第一个 `await` 之前同步拿到**。只查「entry 还在不在」不够：
    //    `storeCredential` 是异步的，两条路会在任何一方 settle 之前**双双通过检查**，
    //    同一个 token 被存两遍（本仓用例实测到过）。
    //
    // ⚠️ 而且**输的那条不能只拿到 null**：赢家「已占锁、尚未 settle」的那段窗口里，
    //    墓碑还不存在，输家会查不到结果而报 404 —— 用户明明成功了却看到失败（同样实测到）。
    //    ⇒ 赢家把自己那次 settle 挂出来，输家 await 它，两条路报同一个结果。
    const inflight = this.settling.get(challengeRef);
    if (inflight !== undefined) {
      cred.zeroize(); // 输的这份也必须擦（P1-4a：`storeCredential` 的 finally 是唯一擦它的地方）
      return await inflight;
    }
    const entry = this.sessions.get(challengeRef);
    if (!entry || entry.status !== 'pending') {
      cred.zeroize();
      return null;
    }
    entry.status = 'success'; // ← 同步翻位，这就是那把锁
    const work = (async (): Promise<string> => {
      const maskedIdentifier = await this.storeCredential(this.adapter(runtimeId), cred);
      await entry.session.dispose();
      this.sessions.settle(challengeRef, {
        runtimeId,
        status: 'success',
        maskedIdentifier,
        evictAt: entry.expiresAt,
      });
      return maskedIdentifier;
    })();
    this.settling.set(challengeRef, work);
    try {
      return await work;
    } finally {
      // settle 已经留下墓碑，之后来的走 `sessions.outcome()` 那条，不必再留着这份 promise。
      this.settling.delete(challengeRef);
    }
  }

  private async awaitDeviceCompletion(runtimeId: string, challengeRef: string): Promise<void> {
    const entry = this.sessions.get(challengeRef);
    if (!entry) return;
    const adapter = this.adapter(runtimeId);
    let status: AuthOutcomeStatus = 'error';
    let maskedIdentifier: string | undefined;
    try {
      const cred = await adapter.completeAuth(
        entry.challenge.toDto(),
        {},
        {
          pty: entry.session.pty,
          homeDir: entry.session.homeDir,
          challengeRef,
          deviceCodeExpiresAt: entry.challenge.expiresAt,
        },
      );
      maskedIdentifier = await this.storeCredential(adapter, cred);
      status = 'success';
    } catch (e) {
      // an expired challenge surfaces as a distinct `expired` terminal (vs generic error)
      // so the frontend can guide "code expired → restart" rather than "login failed".
      // structural, for the same reason `mapAdapterError` is (04 §4 ★4z): a third-party
      // adapter's plain Error carrying this code must produce the same 「码过期，请重来」
      // terminal a built-in's does, not a generic failure.
      status = adapterAuthErrorCodeOf(e) === 'AUTH_CHALLENGE_EXPIRED' ? 'expired' : 'error';
      this.logger.warn(`device login ${challengeRef} failed: ${(e as Error).message}`);
    } finally {
      await entry.session.dispose();
      // Drop the heavy live entry (releasing the pty session) and retain only the tiny
      // terminal tombstone for subsequent polls (P2 memory leak fix).
      this.sessions.settle(challengeRef, {
        runtimeId,
        status,
        maskedIdentifier,
        evictAt: entry.expiresAt,
      });
      // opportunistically drop any tombstones the frontend never polled (bounds growth).
      this.sessions.sweepOutcomes(this.clock.now());
    }
  }

  /**
   * POST .../credentials/secret — the NON-interactive short-circuit (05 §3.1). No
   * helper, no pty: the user already holds the secret.
   *
   * ⚠️ `method` IS NOW CARRIED THROUGH INSTEAD OF ASSUMED. The contract has always
   * declared `createCredentialFromSecret(method: 'api-key' | 'access-token-paste', …)`,
   * but every gate on the way here was welded to `api-key`: the wire schema was
   * `z.literal('api-key')`, the controller dropped `dto.method`, and this line passed a
   * hard-coded `'api-key'`. So an adapter whose account credential is a pasted access
   * token had a declared, contract-supported path that could not be reached from
   * outside — and nothing failed; the method simply vanished.
   */
  async submitSecret(
    runtimeId: string,
    method: RuntimeSecretMethod,
    secret: string,
  ): Promise<{ maskedIdentifier: string }> {
    const adapter = this.adapter(runtimeId);
    if (!adapter.createCredentialFromSecret) {
      throw new BadRequestException(`${runtimeId} does not support ${method}`);
    }
    // The door is「the adapter offers this method」, asked of the adapter — same policy
    // object `beginAuth` uses, so the two entrances cannot drift apart.
    try {
      AuthMethodPolicy.assertSupported(method, adapter.getAuthMethods());
    } catch (e) {
      if (e instanceof UnsupportedAuthMethodError) throw unsupportedMethod(e);
      throw e;
    }
    // The adapter owns its provider's key FORMAT (05 §3.1) — no `runtimeId === 'codex'`
    // branch here; an adapter without a check imposes no format constraint.
    //
    // ⚠️ ONLY FOR `api-key`. `validateApiKey` is, by its own contract wording, an
    // 「api-key FORMAT check (prefix/length/charset)」 — running it over a pasted ACCESS
    // TOKEN would reject a perfectly good credential for failing to look like a
    // different kind of secret. An adapter that wants to validate a pasted token does
    // it inside `createCredentialFromSecret`, where it knows which of the two it got.
    if (method === 'api-key') {
      const verdict = adapter.validateApiKey?.(secret) ?? { ok: true };
      if (!verdict.ok) {
        // never echo the value (P2-3) — only the reason.
        //
        // ⛔ 以前是 `invalid api key: ${reason} (AUTH_REJECTED)` 一句英文散文，两个毛病：
        //    ① 码拼进散文，而信封 `code` 是 `codeForStatus(401)` 的 `UNAUTHORIZED` —— 又是自相矛盾；
        //    ② 精确的 reason 只活在 message 里，而前端读的是 `details[].message`
        //       （`useRuntimeAuthFlow.reasonsFromError`）⇒ 六条判定一条都没上屏。
        // ⇒ 码归 code 位、原因归 details、message 只留人话。
        throw new UnauthorizedException({
          code: 'AUTH_REJECTED',
          message: '这串 API Key 没有通过格式检查，没有保存。',
          retryable: false,
          // 校验在存库之前，这一支确实什么都没动过。
          sideEffectFree: true,
          // 前端读的就是这一位（`details[].message`）。adapter 没给理由时**不造一条** ——
          // 空的 details 会让前端落到它自己的兜底句，那比编一个理由好。
          ...(verdict.reason === undefined || verdict.reason === ''
            ? {}
            : { details: [{ message: verdict.reason }] }),
        });
      }
    }
    const cred = await adapter.createCredentialFromSecret(method, secret);
    const masked = await this.storeCredential(adapter, cred);
    return { maskedIdentifier: masked };
  }

  /** PUT .../auth-mode — switch mode; I-RTS-2 target-mode-has-no-credential → 409. */
  async setAuthMode(runtimeId: string, mode: RuntimeAuthMode): Promise<RuntimeSettingsDto> {
    this.adapter(runtimeId); // 404 for unknown runtime
    const view = await this.credentials.view(runtimeId, mode);
    if (view.credentialStatus === 'none') {
      throw new ConflictException(
        `no ${mode} credential configured for ${runtimeId} — configure it first`,
      );
    }
    const now = this.clock.now();
    const existing = await this.settings.findByRuntime(runtimeId);
    // 首配与切换走两个工厂，因为「有没有来处」是审计行要写出来的差别 —— 见
    // `RuntimeSettings.configureFirst()` 的注释。
    const settings = existing ?? RuntimeSettings.configureFirst(runtimeId, mode, now);
    if (existing) existing.switchTo(mode, now);
    this.uow.run((tx) => {
      this.settings.saveSync(tx, settings);
      // ⚠️ 这一行决定**此后每一个沙箱**注入哪份凭证（05 §4.1）。事件是它进审计流的
      // 唯一通道 —— 23 §12 / 24 §214 一直写着它，实现里此前没有。
      this.events.publishInTx(tx, settings.pullEvents());
    });
    return { runtimeId, activeAuthMethod: settings.activeAuthMethod };
  }

  /** DELETE .../credentials/:id — revoke (05 §4; triggers sandbox revoke coordination). */
  async revokeCredential(runtimeId: string, credentialId: string): Promise<void> {
    this.adapter(runtimeId);
    await this.credentials.revoke(runtimeId, credentialId);
  }

  /** Build the store input from an adapter credential + compute expiry, then store. */
  private async storeCredential(adapter: RuntimeAdapter, cred: RuntimeCredential): Promise<string> {
    try {
      // The adapter already SPLIT the material at birth (05 §4.3 ②): `credentialFiles`
      // holds the sanitized injectable form, `authFile` the platform-only complete one.
      // They are stored in two separate payload fields and read back by two different
      // facade methods — this layer just carries them across, it never converts.
      const payload: RuntimeSecretPayload = {
        credentialFiles: cred.credentialFiles.length > 0 ? cred.credentialFiles : undefined,
        env: cred.env,
        accessToken: cred.accessToken,
        authFile: cred.authFile,
      };
      const { maskedIdentifier } = await this.credentials.storeRuntimeCredential({
        runtimeId: adapter.id,
        obtainedVia: cred.obtainedVia,
        // ⛔ 回落**不能是 `adapter.id`**：卡片上那一格是「这是哪个帐号」，
        //    塞一个 `codex` 进去等于让运行时的内部键冒充帐号名，用户会以为自己的帐号叫 codex。
        //    没有帐号信息就说没有 —— 这比编一个像模像样的名字诚实。
        maskedIdentifier: cred.maskedIdentifier ?? '已连接（无帐号信息）',
        payload,
        expiresAt: this.expiryFor(adapter, cred.obtainedVia),
      });
      return maskedIdentifier;
    } finally {
      cred.zeroize();
    }
  }

  /**
   * Platform-side expiry for a credential, ASKED OF THE ADAPTER (04 §3
   * `credentialTtlMs`). An adapter that declares no TTL for the method gets `null` —
   * no platform expiry — which is also what a third-party runtime gets until it says
   * otherwise, instead of inheriting a built-in vendor's lifetime.
   */
  private expiryFor(adapter: RuntimeAdapter, method: RuntimeAuthMethod): Date | null {
    const ttlMs = adapter.credentialTtlMs?.[method];
    return ttlMs === undefined ? null : shiftMs(this.clock.now(), ttlMs);
  }

  private adapter(runtimeId: string): RuntimeAdapter {
    if (!this.registry.has(runtimeId)) {
      throw new NotFoundException(`unknown runtime '${runtimeId}'`);
    }
    return this.registry.get(runtimeId);
  }

  /**
   * Adapter error → HTTP (04 §4), dispatched STRUCTURALLY on `code`.
   *
   * ⛔ IT USED TO BE `e instanceof AdapterAuthError`, AND THAT CLOSED A TRAP ON EVERY
   * OUT-OF-TREE ADAPTER (04 §4 ★4z). `AdapterAuthError` lived in this module's `domain`
   * folder, exported from neither `@platform/contracts` nor `@platform/runtime` — so a
   * third party could not construct one. Meanwhile testkit RA-03 explicitly tells them
   * 「a plain Error is tolerated; but an error that DOES carry a code must carry the
   * right one」 and asserts it by reading `code` structurally. Follow the testkit, get a
   * green suite and a **500**, where a built-in throwing the same thing gets a 401 —
   * one question, two criteria. Both halves are fixed: the class now lives in contracts
   * (so `instanceof` also works out of tree), and this dispatch matches the testkit's,
   * so a bare `Error` carrying a valid code is honoured.
   *
   * ⚠️ `adapterAuthErrorCodeOf` only recognises the 04 §4 closed set, so an unrelated
   * `.code` (a Node fs `ENOENT`, `UNKNOWN_RUNTIME`) falls through untouched rather than
   * being coerced into an auth verdict.
   */
  private mapAdapterError(e: unknown): unknown {
    switch (adapterAuthErrorCodeOf(e)) {
      case 'UNSUPPORTED_METHOD':
        return new BadRequestException(messageOf(e));
      case 'AUTH_CHALLENGE_EXPIRED':
        return new NotFoundException(messageOf(e)); // 410-ish; mapped to 404 for MVP
      case 'AUTH_REJECTED':
        return new UnauthorizedException(messageOf(e));
      case 'INSTALL_FAILED':
        // 04 §4: 500. Its real exposure is `starting → failed` inside provision
        // (there is no synchronous response there); this row exists so a future
        // sync entry point has a rule and 02 §6.2 is satisfied.
        return new InternalServerErrorException(messageOf(e));
      default:
        return e;
    }
  }
}

/**
 * The message of whatever was thrown, without assuming it is an `Error`.
 *
 * ⚠️ A third-party adapter may throw a plain object carrying `{ code, message }` — the
 * testkit's structural criterion admits it, so the mapping must not lose the text and
 * hand the user an empty 401.
 */
function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const m: unknown = (e as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(e);
}

/**
 * `UNSUPPORTED_METHOD` → 400，**码在 code 位**。
 *
 * ⛔ 以前是 `new BadRequestException(e.message)`，而 `e.message` 里拼着 `(UNSUPPORTED_METHOD)`
 * ——`codeForStatus(400)` 又给信封盖了个 `BAD_REQUEST`：同一个响应两个码。
 * 这是 runtime 侧三处「把码拼进散文」的最后一处。
 */
function unsupportedMethod(e: UnsupportedAuthMethodError): HttpException {
  return new BadRequestException({
    code: 'UNSUPPORTED_METHOD',
    message: '这个 Agent 不支持这种登录方式。',
    retryable: false,
    // 方式校验是门口的第一道，什么都没动过。
    sideEffectFree: true,
    details: [{ code: 'UNSUPPORTED_METHOD', method: e.method }],
  });
}
