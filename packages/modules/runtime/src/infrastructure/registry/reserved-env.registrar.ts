import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { RUNTIME_ADAPTER_REGISTRY, runtimeReservedEnvNamesOf } from '@platform/contracts';
import type { RuntimeAdapterRegistry } from '@platform/contracts';
import { registerReservedEnvNames } from '@platform/shared-kernel';

/**
 * Fold every registered adapter's `reservedEnvNames` into the platform env blacklist
 * (04 §3 ★3z / 05 §4.1 ★4.1a).
 *
 * ── WHAT IT REPAIRS ──────────────────────────────────────────────────────────
 * The blacklist was a STATIC table, and 05 §4.1 promised a CI reconcile that would go
 * red 「新增 adapter 时若其 `RuntimeCredential` 用到新的 env 名」. It could not: the
 * reconcile compared one hard-coded list against another, and NOTHING enumerated the
 * adapters. Runtime ids are an open registry, so a third party's `ACME_API_KEY` and —
 * far worse — its `ACME_CONFIG_DIR` were simply absent from the list.
 *
 * ⛔ The two classes fail differently, which is why the redirect class is the security
 * half: a user-set CREDENTIAL name is still beaten by the provision env merge order
 * (`{...image.env, ...credential.env}` — the credential is written last and wins). A
 * user-set REDIRECT name has NO such backstop; it points the CLI at whatever directory
 * the user names, including an agent-writable one inside the workspace, and the CLI
 * reads its credentials from there.
 *
 * ── WHY `onApplicationBootstrap` AND NOT `onModuleInit` ──────────────────────
 * Out-of-tree modules register their adapters from their OWN `onModuleInit` (04 §8 方式一).
 * Nest runs every module's `onModuleInit` before any `onApplicationBootstrap`, so this
 * is the earliest hook from which the registry is guaranteed COMPLETE. Doing it in
 * `onModuleInit` would silently collect the built-ins only — and "silently collected
 * less than it should" is precisely the defect being fixed.
 *
 * ⚠️ Nothing consults the blacklist before HTTP is up (it validates user-submitted env),
 * so there is no window in which a request could see the pre-registration list.
 */
@Injectable()
export class ReservedEnvNameRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger('ReservedEnvNameRegistrar');

  constructor(
    @Inject(RUNTIME_ADAPTER_REGISTRY) private readonly registry: RuntimeAdapterRegistry,
  ) {}

  onApplicationBootstrap(): void {
    this.assertNoCredentialEnvCollision();
    const names = runtimeReservedEnvNamesOf(this.registry);
    if (names.length === 0) return;
    registerReservedEnvNames(names);
    this.logger.log(`env blacklist extended by registered runtimes: ${names.join(', ')}`);
  }

  /**
   * ⛔ **两个 adapter 不许用同一个 env 名注入凭证** —— 启动就炸，不留到运行时。
   *
   * ── 它为什么是本切片才需要的 ─────────────────────────────────────────────
   * 在此之前一个沙箱只注入**一份**凭证，撞名不会有后果。现在 provision 会把所有已配置
   * 的凭证合进**同一张** env 表（03 §4.3 ④）：两个 adapter 声明了同一个名字，就意味着
   * 其中一个 CLI 会读到另一家的令牌。
   *
   * ⛔ **不按注册顺序静默覆盖**：注册顺序是模块加载次序，不表达任何意图，"谁在后面谁
   * 赢"没有依据。而后果是沉默的 —— 那个 CLI 不报错，只是"登录不上"，或者更糟：
   * 用另一个账号干活。既有的「凭证永远赢，靠顺序而非黑名单」（05 §4.1）说的是
   * **凭证 vs 用户变量**，那里"谁赢"有明确答案；**凭证 vs 凭证**没有。
   *
   * ⚠️ 这是**声明层**的检查（`reservedEnvNames.credential`），可能不全（adapter 可以
   * 不声明）。provision 在合并**实际** env 时还会再查一次（`mergeCredentialEnv`）——
   * 那一层抓的是声明没覆盖到的。两层都要有：这一层让平台在启动时就说不，
   * 而不是等某个用户建沙箱时才发现。
   */
  private assertNoCredentialEnvCollision(): void {
    const owner = new Map<string, string>();
    for (const adapter of this.registry.list()) {
      for (const name of adapter.reservedEnvNames?.credential ?? []) {
        const previous = owner.get(name);
        if (previous !== undefined && previous !== adapter.id) {
          throw new Error(
            `runtime adapter '${previous}' 与 '${adapter.id}' 都声明用环境变量 '${name}' ` +
              '注入凭证。一个沙箱现在会同时注入多份凭证（03 §4.3 ④），撞名意味着其中一个 ' +
              'CLI 会拿着另一家的令牌运行 —— 这是平台配置错误，必须改掉其中一个 adapter，' +
              '而不是靠注册顺序决定谁赢。',
          );
        }
        owner.set(name, adapter.id);
      }
    }
  }
}
