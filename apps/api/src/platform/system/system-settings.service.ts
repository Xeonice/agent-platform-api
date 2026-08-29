import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { CLOCK, DATABASE, type Clock } from '@platform/shared-kernel';
import type {
  ConnectivityResult,
  InitStatusDto,
  ProxyConfig,
  SystemSettingsDto,
  UpdateSystemSettingsRequest,
} from '@platform/contracts';
import { ConnectivityResultSchema } from '@platform/contracts';
import { PasscodeService } from '../access-passcode/passcode.service';
import {
  SYSTEM_SETTINGS_ROW_ID,
  systemSettings,
  type SystemSettingsRow,
} from './system-settings.sqlite';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * 平台版本。**没有发布流程时说 `dev`，不编一个版本号。**
 *
 * ⚠️ 硬编码 `'1.0.0'` 是最容易写、也最会撒谎的做法：它会在每一次「当前版本 v1.0.0」
 * 的截图里被当成事实，而实际跑的是任意一个 commit。`PLATFORM_VERSION` 由发布流程注入，
 * 没注入就如实说不知道 —— 与 `ImageSeeder` 拒绝硬编码 digest 是同一条纪律。
 */
function platformVersion(): string {
  const v = (process.env.PLATFORM_VERSION ?? '').trim();
  return v === '' ? 'dev' : v;
}

/**
 * `system_settings` 单行表的读写门面（13 §2.8.3）。
 *
 * ── 两条纪律 ────────────────────────────────────────────────────────────────
 * 1. **行按需创建（upsert），不靠迁移插种。** 迁移插种意味着「这一行存在」这件事由
 *    历史迁移保证，而任何一次 `:memory:` 库、任何一次手工建库都会没有它，然后
 *    `GET /api/system/init-status` 报 500 —— 冷启动首屏的 500。
 * 2. **口令那一位不读库。** 今天口令来自 `ACCESS_PASSCODE` env（`PasscodeService`
 *    构造期快照），`access_passcode_hash` 列恒为 NULL；拿空列去回答「启没启用」会在
 *    口令明明开着的时候说「未启用」，而那句话会被人当成安全结论。
 */
@Injectable()
export class SystemSettingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly passcode: PasscodeService,
  ) {}

  /** 单行读取；行不存在就地补出来（纪律 1）。 */
  row(): SystemSettingsRow {
    const found = this.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.id, SYSTEM_SETTINGS_ROW_ID))
      .all();
    if (found.length > 0) return found[0]!;
    this.db
      .insert(systemSettings)
      .values({ id: SYSTEM_SETTINGS_ROW_ID, initialized: false })
      .onConflictDoNothing()
      .run();
    return this.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.id, SYSTEM_SETTINGS_ROW_ID))
      .all()[0]!;
  }

  initialized(): boolean {
    return this.row().initialized;
  }

  proxyConfig(): ProxyConfig | undefined {
    const raw = this.row().proxyConfig;
    if (raw === null || raw === undefined) return undefined;
    return raw as ProxyConfig;
  }

  /**
   * `GET /api/system/init-status`（10 §6.6）。
   *
   * ⚠️ **不重跑检测**，只把上次的结果原样附上（外加它的时刻，否则前端无从判断那份结果
   * 是三秒前的还是三周前的）。要新鲜结果就点 [重新检测] 走 `/diagnose` —— 那是用户
   * 显式要的，而这个端点是冷启动首屏的第一跳。
   */
  initStatus(): InitStatusDto {
    const row = this.row();
    const parsed = parseConnectivity(row.lastConnectivityCheck);
    return {
      initialized: row.initialized,
      ...(row.initializedAt ? { initializedAt: row.initializedAt.toISOString() } : {}),
      ...(parsed ? { lastConnectivityCheck: parsed } : {}),
      ...(row.lastConnectivityCheckAt && parsed
        ? { lastConnectivityCheckAt: row.lastConnectivityCheckAt.toISOString() }
        : {}),
    };
  }

  /** `GET /api/system/settings`。⛔ 不出 hash，只出「启没启用」（见类注释纪律 2）。 */
  settings(): SystemSettingsDto {
    const row = this.row();
    return {
      initialized: row.initialized,
      ...(row.proxyConfig ? { proxyConfig: row.proxyConfig as ProxyConfig } : {}),
      ...(row.publicBaseUrl ? { publicBaseUrl: row.publicBaseUrl } : {}),
      accessPasscodeEnabled: this.passcode.enabled,
      ...(row.accessPasscodeUpdatedAt
        ? { accessPasscodeUpdatedAt: row.accessPasscodeUpdatedAt.toISOString() }
        : {}),
      version: { platform: platformVersion(), node: process.version },
    };
  }

  /**
   * `PUT /api/system/settings` —— **只存配置，不放行**。
   *
   * ⚠️ 这里一个字都不碰 `initialized`。把「保存了代理」顺手当成「初始化完成」，会让
   * 运行期的一次改代理悄悄重放一次初始化语义（`initializedAt` 被改写、审计里多一条
   * 本不该有的 `system.initialized`）；反过来，向导里少调一次 `/init` 也不会被发现。
   * 两个端点各自只做一件事，这条边界才有地方成立。
   *
   * ⚠️ **`null` 是清空，缺席是不改。** 少了前者，一个配错的代理就删不掉。
   */
  update(patch: UpdateSystemSettingsRequest): SystemSettingsDto {
    this.row();
    const values: Partial<typeof systemSettings.$inferInsert> = {};
    if (patch.proxyConfig !== undefined) {
      values.proxyConfig = patch.proxyConfig === null ? null : normalizeProxy(patch.proxyConfig);
    }
    if (patch.publicBaseUrl !== undefined) {
      values.publicBaseUrl = patch.publicBaseUrl === null ? null : patch.publicBaseUrl.trim();
    }
    if (Object.keys(values).length > 0) {
      this.db
        .update(systemSettings)
        .set(values)
        .where(eq(systemSettings.id, SYSTEM_SETTINGS_ROW_ID))
        .run();
    }
    return this.settings();
  }

  /** `POST /api/system/init` 的落库那一步（放行 + 存代理 + 存这一轮的检测结果）。 */
  markInitialized(
    proxy: ProxyConfig | undefined,
    connectivity: readonly ConnectivityResult[],
  ): void {
    this.row();
    const now = this.clock.now();
    this.db
      .update(systemSettings)
      .set({
        initialized: true,
        initializedAt: now,
        ...(proxy === undefined ? {} : { proxyConfig: normalizeProxy(proxy) }),
        lastConnectivityCheck: [...connectivity],
        lastConnectivityCheckAt: now,
      })
      .where(eq(systemSettings.id, SYSTEM_SETTINGS_ROW_ID))
      .run();
  }

  /**
   * 每一轮 `/diagnose` 的出网结论都回写这里 —— 于是 `init-status` 附的「上次检测」
   * 总是**最近一次真的跑过的那一次**，而不是永远停在初始化那一刻。
   */
  recordConnectivity(connectivity: readonly ConnectivityResult[]): void {
    if (connectivity.length === 0) return;
    this.row();
    this.db
      .update(systemSettings)
      .set({ lastConnectivityCheck: [...connectivity], lastConnectivityCheckAt: this.clock.now() })
      .where(eq(systemSettings.id, SYSTEM_SETTINGS_ROW_ID))
      .run();
  }
}

/** 空串等于没填 —— 让 `{httpProxy: ''}` 落成 `{}`，而不是「代理地址是空串」。 */
function normalizeProxy(proxy: ProxyConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(proxy)) {
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim();
  }
  return out;
}

/**
 * 读回 json 列时**重新按 schema 校验**。
 *
 * ⚠️ 不是仪式：这一列是 `text` + `mode:'json'`，库里躺的可能是上一版形状写下的东西
 * （本列本身就是本轮新增的），而 DTO 那一侧是 `createZodDto` 的响应类型 —— 形状对不上时
 * 前端拿到的是一个通不过它自己校验的对象。校验不过就当作「没有上次结果」，
 * 这是一个可渲染的状态；把坏数据原样透出去不是。
 */
function parseConnectivity(raw: unknown): ConnectivityResult[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const parsed = ConnectivityResultSchema.array().safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
