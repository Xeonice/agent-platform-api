import type { AuditSeverity } from './schemas/system.schema';

/**
 * SSE 帧契约 —— `POST /api/system/diagnose` 的**流帧唯一权威定义**（后端侧副本）。
 *
 * SYNC WITH `web/src/types/sse-protocol.ts`（前端副本）与 docs/backend/02 §5.3。
 *
 * ── 为什么它必须手写，而且必须与 ws-protocol.ts 同放 ─────────────────────────
 * 10 §6 已经写死了这条边界：`openapi-typescript` **只能生成 `/diagnose` 的
 * content-type 声明**，生成不出流里逐帧的形状 —— openapi 的 response schema 描述的是
 * 「一个响应体」，而 SSE 的响应体是一条**无穷长的帧序列**。所以这份类型与 WS 帧一样是
 * 「两仓各持一份手抄」，走同一套 `// SYNC WITH` 纪律。
 *
 * ⚠️ **手抄 + 零守卫 = 下一个 `TRIGGERED_BY`。** 本仓刚在 `TRIGGERED_BY` 上发现「三份
 * 手抄、零守卫」；WS 帧靠 `scripts/docs-check.mjs` 的 **B4** 跨仓对账兜住，SSE 帧如果
 * 只靠人工同步，就是同一个坑换个位置。⇒ 本文件导出
 * {@link SSE_PROTOCOL_CANONICAL}，两仓**逐字节相同**，由主仓的 **B5** 对账。
 *
 * ── 一个判别键：`event` ──────────────────────────────────────────────────────
 * SSE 传输层自己就有 `event:` 行，帧体里再重复一次是**刻意的**：
 *   · 消费方可能用 `fetch` + `ReadableStream`（要带 POST body，`EventSource` 不支持），
 *     那条路上 `event:` 行要自己 parse，漏掉一行整个 union 就退化成 `unknown`；
 *   · 与 `/terminal`、`/tasks` 的 `type` 刻意用**不同的键名**，任何一方的帧被误 parse
 *     成另一方时会当场失败，而不是安静地少几个字段（10 §7.4 的同一条理由）。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 检查项 id —— 固定顺序，就是 P21-5 §6 的展示顺序
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 八项的 id，**数组顺序 = 展示顺序**（P21-5 §6：「异步并行但顺序固定」）。
 *
 * ⚠️ **前端不得自己维护一份这个清单。** 每一轮诊断的第一帧（`start`）会把本数组
 * 原样下发，前端据它渲染「未完成项 ⏳」的占位 —— 因为在第一个 `check` 帧到达之前，
 * 页面必须已经知道总共有几项、分别叫什么。让前端硬抄一份，就等于在 WS 那三份手抄
 * 之外再造第四份。
 */
export const DIAGNOSE_CHECK_IDS = [
  'container-runtime',
  'dev-kvm',
  'disk-space',
  'port-conflict',
  'outbound-network',
  'ws-loopback',
  'data-root-fs',
  'preset-image',
] as const;
export type DiagnoseCheckId = (typeof DIAGNOSE_CHECK_IDS)[number];

/**
 * 每一项的结论。
 *
 * ⚠️ **`info` 不是「弱化的 warn」，它是「没有任何东西需要修」。** 预制镜像五步链的
 * 第 5 步（未 staged）就只能是 `info`：镜像是好的，只是这台机器还没把 rootfs 铺开，
 * 第一个 Task 会慢几分钟。渲染成 ⚠️ 会让用户去修一个不需要修的东西 —— 而他能找到的
 * 「修法」只有删镜像重推，那会让情况更糟（P21-5 §9A 第 5 步）。
 *
 * ⚠️ **`timeout` 与 `fail` 分开**，因为下一步不同：`fail` 是「查出来是坏的」，
 * `timeout` 是「5s 内没查出来」—— 后者在「系统好像坏了」的场景里恰恰是最常见的一种，
 * 而它**不构成**「这一项是坏的」的结论（02 §5.3：一项卡住不阻塞整轮）。
 */
export const DIAGNOSE_STATUSES = ['ok', 'info', 'warn', 'fail', 'timeout'] as const;
export type DiagnoseStatus = (typeof DIAGNOSE_STATUSES)[number];

/**
 * 预制镜像检查链的五步（P21-5 §9A）。**跟着失败帧一起下发，不许合成一条。**
 *
 * ⛔ 五步的失败**不许**合成一条「镜像不可用」—— 它们的下一步动作完全不同：
 *
 * | step | 失败意味着 | 用户下一步 |
 * |---|---|---|
 * | `config` | `SANDBOX_DEFAULT_IMAGE` 没配，回落到必炸的兜底 | **改配置** |
 * | `registry` | 配了，但 registry 里解析不到 | **推镜像** / 改地址 |
 * | `lineage` | 解析到了，但那是上游镜像不是平台自建的那张 | **换成自建的那张**（注册也会被拒） |
 * | `registration` | 是对的那张，但没注册进平台 / 不是 valid | **重启平台**（开机播种） |
 * | `staged` | —— **这一步不是失败** —— | 只是等一会 |
 *
 * ⚠️ 合成一条等于把诊断退化成一个红灯：「镜像不可用」这五个字对以上五种情况一字不差，
 * 而用户能做的事一个都不一样。
 */
export const PRESET_IMAGE_STEPS = [
  'config',
  'registry',
  'lineage',
  'registration',
  'staged',
] as const;
export type PresetImageStep = (typeof PRESET_IMAGE_STEPS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// 帧
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 首帧。**在任何一项跑完之前发出**，让页面立刻能画出八个 ⏳ 占位。
 *
 * ⚠️ 它不是可省的装饰。没有它，前端要么自己硬抄一份八项清单（= 第四份手抄），要么
 * 只能「收到一项画一项」—— 而并行执行下最快的那项可能是第 ⑥ 项，页面会先画出一行
 * 孤零零的「WS 回环 ✅」，看起来像诊断只有一项。
 */
export interface DiagnoseStartFrame {
  event: 'start';
  /** 固定顺序（= {@link DIAGNOSE_CHECK_IDS}）+ 每项的中文标题。 */
  checks: Array<{ id: DiagnoseCheckId; label: string }>;
  /** 单项超时预算（ms）。服务端保证，前端**不要自己计时**（F21-5 §7.1 ②）。 */
  timeoutMs: number;
}

/**
 * 逐项结论。八项**并行**跑，所以到达顺序**不等于** {@link DIAGNOSE_CHECK_IDS} 的顺序
 * —— 前端按 id 归位，不要按到达顺序追加（02 §5.3 订正：整轮 ≈ 最慢那项 ≈ 5s，
 * 不是累加的 40s）。
 */
export interface DiagnoseCheckFrame {
  event: 'check';
  id: DiagnoseCheckId;
  label: string;
  status: DiagnoseStatus;
  /**
   * 一行人话，**直接上 UI**。
   *
   * ⚠️ 它必须自带可执行性。「端口 3000 被占用」这句话对用户没有任何用 —— 他下一步要做的
   * 是**找出占它的东西**，而那恰恰是诊断能直接答、用户手动查却很费劲的部分
   * （P21-5 §9B）。所以端口那一项的 summary 长这样：
   * 「端口 3000（平台 HTTP/WS 服务）被 com.docke (pid 41235) 占用」。
   */
  summary: string;
  /**
   * 修复建议 —— **可复制的命令或配置项**，不是「请检查网络」这种。
   * P21-5 §6：「修复建议 | 点击复制命令到剪贴板」。
   */
  hint?: string;
  /** 仅 `id: 'preset-image'`：链走到哪一步（见 {@link PresetImageStep}）。 */
  step?: PresetImageStep;
  /**
   * 机器码。**只在预制镜像链上出现**（见 {@link PRESET_IMAGE_CODES}）。
   *
   * ⚠️ 其余七项**刻意不发码**：码的价值在于「前端按它查一句固定文案」，而那七项的
   * 结论本来就带着这一次实测出来的具体数字（哪个端口、被谁占、还剩多少 GB），固定文案
   * 反而更差。凭空为它们造一批只出现在这一个端点的码，只会让 10 §6.8 的码表变长而
   * 没有任何消费方 —— 那正是「⏳ 已定案、但今天没有产出方」那一节存在的原因。
   */
  errorCode?: string;
  /** 结构化细节（端口的 pid、磁盘的字节数、镜像的 digest…）。已脱敏。 */
  detail?: Record<string, unknown>;
  durationMs: number;
}

/** 汇总帧。收到它 = 整轮结束，前端应关闭连接（F21-5 §7.1 ④：无悬挂 EventSource）。 */
export interface DiagnoseDoneFrame {
  event: 'done';
  okCount: number;
  infoCount: number;
  warnCount: number;
  failCount: number;
  /** 整轮墙钟耗时。**并行**，所以它 ≈ 最慢那项，不是各项之和（02 §5.3）。 */
  totalMs: number;
}

export type DiagnoseServerFrame = DiagnoseStartFrame | DiagnoseCheckFrame | DiagnoseDoneFrame;

// ─────────────────────────────────────────────────────────────────────────────
// 预制镜像链的四个错误码（10 §6.8 主表有对应行，A5 对账）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 第 1 步：`SANDBOX_DEFAULT_IMAGE` 没配，平台回落到兜底坐标。
 *
 * 兜底那张是**上游**镜像（`ghcr.io/agent-infra/sandbox`），它没有平台的沙箱 API、
 * 没有 tmux、没有常驻进程 —— 容器一退端口就空，**必炸**（P21-5 §9A 第 1 步 /
 * `shared-kernel/domain/builtin-image.ts`：兜底值的作用是让「没配」被看见）。
 */
export const PRESET_IMAGE_NOT_CONFIGURED = 'PRESET_IMAGE_NOT_CONFIGURED';
/** 第 2 步：配了，但 registry 里解析不到（不存在 / 不可达 / 需要凭证）。 */
export const PRESET_IMAGE_NOT_IN_REGISTRY = 'PRESET_IMAGE_NOT_IN_REGISTRY';
/**
 * 第 3 步：解析到了，但它不是平台自建的那一张。
 *
 * ⚠️ 这一步最容易被误解，所以它必须是**独立的一个码**：上游镜像只是平台镜像的 `FROM`，
 * 注册时会被血统检查拒（04 §7 ★血统）。报错必须说清「注册也会被拒」，否则用户会以为
 * 只是少做了一步注册，照着去注册再撞一次墙（P21-5 §9A 第 3 步）。
 */
export const PRESET_IMAGE_NOT_PLATFORM_BUILT = 'PRESET_IMAGE_NOT_PLATFORM_BUILT';
/** 第 4 步：是对的那张，但平台里没有一条 `valid` 且启用的注册记录（开机播种没成）。 */
export const PRESET_IMAGE_NOT_SEEDED = 'PRESET_IMAGE_NOT_SEEDED';

/**
 * 搬运不可行：这台机器上够不着这张镜像的字节（本机 docker 库没有、发布资产清单也没命中）。
 *
 * ⚠️ **它是「去构建」而不是「重试」**，所以 `retryable: false`：同一台机器上再点一次
 * 只会得到同一个答案。这也是它必须与下面那个码分开的理由 —— 两者处置相反。
 */
export const PRESET_IMAGE_NOT_PROVISIONABLE = 'PRESET_IMAGE_NOT_PROVISIONABLE';
/**
 * 已经有一次搬运在进行中。
 *
 * ⚠️ **不做成幂等 200「复用那条流」**：两条流同时往 registry 写同一个 tag 是竞态，而且
 * 第二个调用方通常是用户手抖点了第二下 —— 告诉他「已经在搬了」比默默再开一条正确得多。
 */
export const PRESET_IMAGE_PROVISION_IN_FLIGHT = 'PRESET_IMAGE_PROVISION_IN_FLIGHT';

/** 搬运阶段的闭集 —— 与 `PROVISION_STAGES` 同源，前端按它画进度格。 */
export const PROVISION_STAGE_NAMES = ['plan', 'fetch', 'verify', 'load', 'register'] as const;
export type ProvisionStageName = (typeof PROVISION_STAGE_NAMES)[number];

/**
 * 搬运流的帧。
 *
 * ⚠️ **`progress` 可以是 `null` 且那是有意义的取值**：docker 的进度帧不一定带 `total`
 * （见 `fractionOf`）。前端读到 `null` 要画**不确定态**（转圈），⛔ 不许当成 0 ——
 * 一个停在 0% 不动的进度条与「卡死了」在观感上完全一致。
 */
export interface ProvisionStageFrame {
  event: 'stage';
  stage: ProvisionStageName;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  message: string;
  progress: number | null;
}

/**
 * 收尾帧。
 *
 * ⚠️ **失败也要有这一帧，不能静静断开**：断开在前端看来与网络抖动无法区分，
 * 而这两者的下一步不同（重试 vs 去看 error 说的是哪一阶段）。
 */
export interface ProvisionDoneFrame {
  event: 'done';
  ok: boolean;
  error?: string;
}

export type ProvisionServerFrame = ProvisionStageFrame | ProvisionDoneFrame;

/** 搬运的两个码 —— ⛔ 处置相反（去构建 / 等着），不许合成一个。 */
export const PRESET_IMAGE_PROVISION_CODES = [
  PRESET_IMAGE_NOT_PROVISIONABLE,
  PRESET_IMAGE_PROVISION_IN_FLIGHT,
] as const;
export type PresetImageProvisionCode = (typeof PRESET_IMAGE_PROVISION_CODES)[number];

/** 四个码的闭集 —— 第 5 步没有码，因为它不是失败。 */
export const PRESET_IMAGE_CODES = [
  PRESET_IMAGE_NOT_CONFIGURED,
  PRESET_IMAGE_NOT_IN_REGISTRY,
  PRESET_IMAGE_NOT_PLATFORM_BUILT,
  PRESET_IMAGE_NOT_SEEDED,
] as const;
export type PresetImageCode = (typeof PRESET_IMAGE_CODES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// 跨仓 canonical（B5 对账基准）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 两仓各持一份、**必须逐字节相同**的帧形状描述 —— 与 `WS_PROTOCOL_CANONICAL` 同款，
 * 由 `scripts/docs-check.mjs` 的 **B5** 对账。
 *
 * ⚠️ **它不比较结构，只比较这一个字面量**，理由与 B4 一样：比结构会脆（两侧一个用
 * zod、一个用 TS interface），而比字面量意味着**改帧形状就必须两边同时改**。
 *
 * ⚠️ 它连**检查项 id 与顺序**、**status 取值**、**五步名**一起钉住。这三样都是
 * 「前端会照着写渲染分支」的东西：少一项 id 前端画不出占位，多一个 status 前端的
 * 图标映射会掉进 default 分支，五步名对不上则「不许合成一条」那条纪律就没了落点。
 */
export const SSE_PROTOCOL_CANONICAL =
  'diagnose.server:start{checks[{id,label}],timeoutMs},' +
  'check{id,label,status,summary,hint?,step?,errorCode?,detail?,durationMs},' +
  'done{okCount,infoCount,warnCount,failCount,totalMs}|' +
  'diagnose.status:ok,info,warn,fail,timeout|' +
  'diagnose.checks:container-runtime,dev-kvm,disk-space,port-conflict,' +
  'outbound-network,ws-loopback,data-root-fs,preset-image|' +
  'diagnose.preset-image.steps:config,registry,lineage,registration,staged|' +
  'diagnose.preset-image.codes:PRESET_IMAGE_NOT_CONFIGURED,PRESET_IMAGE_NOT_IN_REGISTRY,' +
  'PRESET_IMAGE_NOT_PLATFORM_BUILT,PRESET_IMAGE_NOT_SEEDED|' +
  'provision.server:stage{stage,status,message,progress},done{ok,error?}|' +
  'provision.stages:plan,fetch,verify,load,register|' +
  'provision.status:running,ok,failed,skipped|' +
  'provision.codes:PRESET_IMAGE_NOT_PROVISIONABLE,PRESET_IMAGE_PROVISION_IN_FLIGHT';

/**
 * 诊断流的 schema 版本，随响应头 `X-Schema-Hash` 下发。
 *
 * ⚠️ 与 `WS_SCHEMA_HASH` / `WS_TASKS_SCHEMA_HASH` **各自独立**：诊断帧改版不该把所有
 * 开着的终端和任务流一起打断，反之亦然。同一条纪律 —— 它是**手钉的字面量**，因为对面
 * 那份也是手钉的，任何由 canonical 派生出来的哈希都不可能与前端硬写的字符串相等
 * （shared/14 §2.4 的 codegen 工具链落地前，两边只能一起手动动）。
 *
 * ⚠️ **SSE 侧它是「告知」而不是「门」**：诊断的使用场景是「系统好像坏了」，此时因为
 * 版本不匹配而拒绝一次只读诊断，等于在最需要它的时候把它关掉。前端读到不认识的
 * hash 应当照常渲染已认识的帧并提示升级，而不是中断。
 */
export const SSE_DIAGNOSE_SCHEMA_HASH = 'sb-diagnose-v1';

/**
 * 诊断结论 → 审计严重度的映射（`system.diagnose` 那条审计用，13 §2.8.2）。
 *
 * ⚠️ `info` 与 `ok` 都不构成告警 —— 见 {@link DIAGNOSE_STATUSES} 对 `info` 的说明。
 */
export function diagnoseSeverity(statuses: readonly DiagnoseStatus[]): AuditSeverity {
  if (statuses.includes('fail')) return 'error';
  if (statuses.some((s) => s === 'warn' || s === 'timeout')) return 'warn';
  return 'info';
}

/**
 * `system.diagnose` **该不该记**（13 §2.8.2）。
 *
 * ⚠️ **只在有失败项时记。** 页面上就有 [重新诊断]，横幅也能跳进来自动跑一次；全绿也记
 * 的话，一个长命平台一天就能堆出上百条「一切正常」，把真正的信号冲掉 —— 纪律与
 * `sandbox.health`「只在状态翻转时记」同源。
 *
 * ⚠️ 「失败项」含 `timeout`：一项 5s 内答不上来，与它答「坏了」对排障是同一件事
 * （「上一次说好/说坏是什么时候」这个问题，`timeout` 属于「没说好」）。
 * `warn` 同样计入 —— 它是产品意义上的「⚠️ 有东西要修」。
 */
export function shouldRecordDiagnose(statuses: readonly DiagnoseStatus[]): boolean {
  return statuses.some((s) => s === 'fail' || s === 'warn' || s === 'timeout');
}
