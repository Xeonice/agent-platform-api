import { Inject, Injectable } from '@nestjs/common';
import { gte, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { CLOCK, DATABASE, shiftMs, type Clock } from '@platform/shared-kernel';
import {
  IMAGE_SPEC_REGISTRY,
  RUNTIME_ADAPTER_REGISTRY,
  RUNTIME_SETTINGS_READER,
  SANDBOX_PROVIDER_REGISTRY,
} from '@platform/contracts';
import type {
  ImageSpecRegistry,
  ProviderHealthDto,
  ProviderRegistry,
  RuntimeAdapterRegistry,
  RuntimeSettingsReader,
  SystemProvidersDto,
} from '@platform/contracts';
import { sandboxes } from '@platform/sandbox';

type Db = BetterSQLite3Database<Record<string, never>>;

/** 失败率的统计窗口 —— P21-5 §3 那句「最近 1h 失败率 5%」。 */
export const HEALTH_WINDOW_MS = 60 * 60 * 1000;
/** ❌ 线（P21-5 §3：>1% ⚠️ · >10% ❌）。`healthy` 说的是有没有越过 ❌ 线。 */
export const UNHEALTHY_FAILURE_RATE = 0.1;

/**
 * `GET /api/system/providers` —— **平台运维看板**（10 §6.6）。
 *
 * ⚠️ **与已落地的 `GET /api/providers` 是两个端点，不要合并。** 那条是 sandbox 上下文的
 * **能力发现**，只服务「建 Task 选 provider」这条业务链路，字段就三个（name /
 * capabilities / isDefault）；这条是运维视角，范围更宽（provider **+ runtime +
 * imageSpec** + 健康/失败率），读者是在排障的人。前端的查询 key 也不同
 * （`['providers','list']` vs `['system','providers']`）。合并会让「建任务」这条主链路的
 * 请求顺带扫一遍 sandboxes 表算失败率。
 *
 * ── `healthy` 是怎么来的（以及它**不**是什么）─────────────────────────────────
 * ⚠️ `SandboxProvider` 契约里**没有健康探测方法**（04 §2.2 的六必需 + 两可选里没有它），
 * 而凭空调一次 `create`/`destroy` 去「探活」既有副作用又慢 —— 一个为了点亮绿灯而真的
 * 起一个沙箱的看板是荒谬的。所以这里用平台**已经拥有**的事实：`sandboxes` 表里这个
 * provider 最近一小时的成败。
 *
 * ⚠️ **`sampleSize: 0` 是「这一小时没人用过它」，不是「正常」。** 前端应当照实说
 * 「无样本」。「不知道」既不是 `false` 也不是 `true` —— 这条纪律与 `imageStaged`
 * 「不知道不是 false」同源。`recentFailureRate` 因此在无样本时**缺席**（0/0 不是 0%）。
 */
@Injectable()
export class SystemProvidersService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
    @Inject(RUNTIME_ADAPTER_REGISTRY) private readonly runtimes: RuntimeAdapterRegistry,
    @Inject(IMAGE_SPEC_REGISTRY) private readonly specs: ImageSpecRegistry,
    @Inject(RUNTIME_SETTINGS_READER) private readonly runtimeSettings: RuntimeSettingsReader,
  ) {}

  async overview(): Promise<SystemProvidersDto> {
    const since = shiftMs(this.clock.now(), -HEALTH_WINDOW_MS);
    const stats = this.failureStats(since);

    const providers: ProviderHealthDto[] = this.providers.list().map((p) => {
      const s = stats.get(p.name) ?? { total: 0, failed: 0 };
      const rate = s.total === 0 ? null : s.failed / s.total;
      return {
        id: p.name,
        capabilities: p.capabilities,
        isDefault: p.name === this.providers.defaultProvider,
        healthy: rate === null ? true : rate <= UNHEALTHY_FAILURE_RATE,
        ...(rate === null ? {} : { recentFailureRate: Number(rate.toFixed(4)) }),
        sampleSize: s.total,
        failureCount: s.failed,
      };
    });

    const runtimes = await Promise.all(
      this.runtimes.list().map(async (r) => ({
        id: r.id,
        displayName: r.displayName,
        vendor: r.vendor,
        authMethods: r.getAuthMethods(),
        credentialConfigured: (await this.runtimeSettings.activeAuthMethod(r.id)) !== null,
      })),
    );

    return {
      providers,
      runtimes,
      imageSpecs: this.specs
        .list()
        .map((s) => ({ id: s.name, isDefault: s.name === this.specs.defaultProvider })),
      healthWindowMs: HEALTH_WINDOW_MS,
    };
  }

  /**
   * 每个 provider 在窗口内建过多少个沙箱、其中多少个 `failed`。
   *
   * ⚠️ 按 `created_at` 而不是 `updated_at` 划窗口：要回答的是「最近一小时**发起的**任务
   * 里有多少成不了」。用 `updated_at` 会把一个三天前建的沙箱因为刚被销毁而算进这一小时，
   * 失败率就跟着一次清理动作跳变。
   */
  private failureStats(since: Date): Map<string, { total: number; failed: number }> {
    const rows = this.db
      .select({
        provider: sandboxes.provider,
        total: sql<number>`count(*)`,
        failed: sql<number>`sum(case when ${sandboxes.status} = 'failed' then 1 else 0 end)`,
      })
      .from(sandboxes)
      .where(gte(sandboxes.createdAt, since))
      .groupBy(sandboxes.provider)
      .all();
    return new Map(
      rows.map((r) => [r.provider, { total: Number(r.total), failed: Number(r.failed ?? 0) }]),
    );
  }
}
