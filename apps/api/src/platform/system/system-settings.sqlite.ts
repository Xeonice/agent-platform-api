import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, check } from 'drizzle-orm/sqlite-core';

/**
 * `system_settings` —— **单行**平台配置表（docs/backend/13 §2.8.3）。
 *
 * 落点与 `audit_events` 同理：它不属于任何限界上下文（13 §2.8 把
 * `audit_events` / `system_settings` / `nodes` 并列为「平台表」），而
 * `apps/api/src/**` 不是 `eslint-plugin-boundaries` 的元素，所以那里是平台级横切设施的
 * 既定落点。
 *
 * ⚠️ **`CHECK (id = 1)` 是这张表的全部约束力所在。** 没有它，「单行配置」就只是一句注释，
 * 而第二行会在某次并发写、某次迁移、某次手工 SQL 之后悄悄出现 —— 此后
 * `select ... limit 1` 读到哪一行取决于 rowid 顺序，而两行的 `initialized` 不同时，
 * 平台会**间歇性地**弹出初始化向导。这类缺陷没有稳定复现路径。
 *
 * 跨方言书写纪律（13 §1 / 28 §3）：枚举 = text + CHECK、不用 `.array()`、
 * 时间戳是 JS `Date`（integer 模式）。
 */
export const systemSettings = sqliteTable(
  'system_settings',
  {
    /** 单行锁。默认值 + CHECK 双保险。 */
    id: integer('id').primaryKey().notNull().default(1),

    /**
     * 初始化向导完成标记（P21-8 §2）。
     *
     * ⚠️ **一次性、不可逆**：`POST /api/system/init` 把它写成 `true`，已经是 `true` 时
     * 返回 409（10 §6.6，P2-4）。`PUT /api/system/settings` **碰不到这一列** —— 放行与
     * 存配置是两件事，见 `UpdateSystemSettingsRequestSchema` 的注释。
     */
    initialized: integer('initialized', { mode: 'boolean' }).notNull().default(false),
    /** 完成时刻。审计里也有一条 `system.initialized`，但那是观察设施，不能当账本读。 */
    initializedAt: integer('initialized_at', { mode: 'timestamp' }),

    /** `{httpProxy?, httpsProxy?, noProxy?}`。⚠️ 可能含 URL userinfo，见 `proxy-redaction.ts`。 */
    proxyConfig: text('proxy_config', { mode: 'json' }).$type<Record<string, string>>(),

    /**
     * 上次出网检测的逐条结果（`ConnectivityResult[]`）+ 时刻。
     *
     * ⚠️ **本列是 13 §2.8.3 之外新增的**，因为 10 §6.6 要求 `GET /api/system/init-status`
     * 「附上次出网检测结果」，而不附就意味着向导 Step 1 一进去就得当场重跑一次 ——
     * 那一屏恰恰是「平台第一次被打开」的那一屏，白等 5s 的代价全落在第一印象上。
     * 存下来还有第二个用处：`initialized` 之后运行期出问题时，能对比「上次好的时候是
     * 什么样」。
     */
    lastConnectivityCheck: text('last_connectivity_check', { mode: 'json' }).$type<unknown[]>(),
    lastConnectivityCheckAt: integer('last_connectivity_check_at', { mode: 'timestamp' }),

    /**
     * 访问口令 **hash**（Argon2id/bcrypt，非可逆），非空即启用（11 §3.1）。
     *
     * ⛔ **只存 hash，且永不出现在任何响应里**（10 §6.6：「永不回显口令 hash」）。
     * 本轮的 `GET /api/system/settings` 只出一个布尔 `accessPasscodeEnabled`。
     *
     * ✅ `PUT /api/system/access-passcode` 落地后本列**就是口令的所在地**（11 §3.1「存储」
     * 那一行）。形态是 `scrypt$N$r$p$<salt-b64>$<dk-b64>`，自描述参数，见 `passcode-hash.ts`。
     *
     * ⚠️ **`ACCESS_PASSCODE` env 仍然优先，而且它一旦非空就把写入口整个关掉**（409
     * `INVALID_STATE`）。理由是平台**改不动别人的部署配置**：让 UI 写库、env 继续生效，
     * 会造出一个「点了禁用、口令还在要」的分裂态；反过来让库盖过 env，则是平台悄悄推翻
     * 运维方显式写下的一行配置。两种都比「如实说这台实例的口令由部署配置固定」更糟。
     */
    accessPasscodeHash: text('access_passcode_hash'),
    accessPasscodeUpdatedAt: integer('access_passcode_updated_at', { mode: 'timestamp' }),

    /**
     * `ap_session` cookie 的 HMAC 签名密钥 —— **与口令无关，这正是它存在的全部理由**。
     *
     * ⚠️ 密钥此前退化到「口令本身」（`PASSCODE_COOKIE_SECRET ?? passcode`）。在口令只能
     * 来自 env 的年代那没有后果；有了 `regenerate` 之后它直接违背 11 §3.1 白纸黑字的
     * 「**已通过的会话不受口令重新生成影响**」—— 换一次口令 = 所有人当场掉线。
     *
     * ⚠️ **必须落库、不能每进程现生成**：cookie 承诺 7 天，而进程内随机数会让每一次重启
     * 都把所有会话作废。首次签发时惰性生成一次，此后原样复用。
     * `PASSCODE_COOKIE_SECRET` 非空时以 env 为准（多实例部署共享密钥的出口），本列不参与。
     */
    accessPasscodeSessionSecret: text('access_passcode_session_secret'),

    /** 拼 webhook 载荷里的 Task 深链（03 §8.5）；未配置时省略该字段。 */
    publicBaseUrl: text('public_base_url'),

    /** v1.5 占位（13 §2.8.3）。 */
    platformVersion: text('platform_version'),
    lastBackupAt: integer('last_backup_at', { mode: 'timestamp' }),
  },
  (t) => ({
    singleRow: check('system_settings_single_row', sql`${t.id} = 1`),
  }),
);

export type SystemSettingsRow = typeof systemSettings.$inferSelect;
export type SystemSettingsInsert = typeof systemSettings.$inferInsert;

/** 单行表永远只有这一个主键值。 */
export const SYSTEM_SETTINGS_ROW_ID = 1;
