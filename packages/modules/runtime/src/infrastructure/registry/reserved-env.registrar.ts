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
    const names = runtimeReservedEnvNamesOf(this.registry);
    if (names.length === 0) return;
    registerReservedEnvNames(names);
    this.logger.log(`env blacklist extended by registered runtimes: ${names.join(', ')}`);
  }
}
