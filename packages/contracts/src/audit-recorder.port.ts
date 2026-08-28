import type { AuditCategory, AuditOutcome, AuditSeverity } from './schemas/system.schema';

/**
 * `AuditRecorder` —— 审计流的**第二个写入口**（13 §2.8.2「写入语义：两个入口」）。
 *
 * ⚠️ **它不是可选项，第一个入口覆盖不了它要覆盖的东西。** 入口 ① 是
 * `AuditProjector` 订阅 `EventBus`，业务事实自动进；但**业务失败时聚合根本不
 * `publish` 领域事件** —— 失败路径上 projector 什么也收不到，而排障需要的恰恰是
 * 失败那一刻。技术过程（provision 每一阶段的耗时、探测的 argv 与退出码、工作区
 * 到底准备出了什么）同理：它们压根不是领域事实，不该也不能挤进 Outbox
 * （13 §2.8.2「往 Outbox 里塞审计用的技术事件，等于给可靠投递通道灌进一堆
 * 没人需要投递的东西，还会拖慢 WS 派发」）。
 *
 * ── 为什么这个 port 在 `contracts` ────────────────────────────────────────────
 * 调用方遍布各个限界上下文的 **application 层**，而 `eslint-plugin-boundaries` 只
 * 允许 application 依赖 `contracts` / `shared-kernel` / 本模块自己的 domain。审计
 * 是平台设施而不是任何一个上下文的领域概念，所以它走 `contracts` 这条既有的
 * 跨上下文协作通道 —— 与 `SANDBOX_EVENT_BROADCASTER` / `CREDENTIAL_FACADE` 同款。
 * 实现（drizzle 落库）在 `apps/api/src/platform/audit/`，与 `audit_events` 这张
 * **平台级表**同处一地。
 *
 * ── 两条调用纪律 ─────────────────────────────────────────────────────────────
 * 1. **`record()` 同步返回、永不抛。** 审计是观察设施不是账本（P21-5 §10.5：
 *    「审计写入永不阻断业务」）。实现内部吞掉自己的异常并降级为一行 error 日志；
 *    调用方**不要**给它加 try/catch，那会让人以为它可能抛。
 * 2. **`detail` 交出去之前不需要你脱敏，但也别故意塞明文。** 脱敏在写入口由实现
 *    统一做（13 §2.8.2 / 05 §4）—— 一处做，不是 N 个调用点各做一遍。
 */
export interface AuditRecordInput {
  category: AuditCategory;
  /** 开放集合。沙箱那一档的清单见 03 §7.8。 */
  type: string;
  /** 缺省 `'info'`（与列默认值一致）。 */
  severity?: AuditSeverity;
  subjectType?: string;
  /**
   * **弱引用，不设 FK**（13 §2.8.2）：审计必须在主体被删除之后继续存在 —— 沙箱销毁、
   * 项目删除之后的那段时间，正是排障最需要它的时候。
   */
  subjectId?: string;
  /**
   * 取值全集见 `AUDIT_ACTORS`（= `TRIGGERED_BY` ∪ `{'system'}`）：
   * `scheduler` / `reaper` / `user` / `health-check` / `provider-event` / `system`。
   * ⚠️ 类型仍是 `string`（列上没有 CHECK，见 `AuditActorSchema`），但**不要**在这里
   * 发明清单外的值 —— 前端的 `ACTOR_LABELS` 按 `AUDIT_ACTORS` 翻中文，发明一个就在
   * 中文界面上漏一个英文标识符。
   */
  actor: string;
  /** 一行人话，直接上 UI。 */
  summary: string;
  detail?: Record<string, unknown>;
  /** 阶段类事件才有；没有它就无法回答「哪一步慢了」（13 §2.8.2）。 */
  durationMs?: number;
  outcome?: AuditOutcome;
  /**
   * 失败时挂 04 §4 的码，**与 `failure_code` 同一闭集**。
   * ⚠️ 不要把码拼进 `summary` 散文里 —— 散文会被改写，能挂文案的钩子会因此消失。
   */
  errorCode?: string;
}

export interface AuditRecorder {
  /** 同步、永不抛（见接口注释纪律 1）。 */
  record(input: AuditRecordInput): void;
}

export const AUDIT_RECORDER = Symbol('AuditRecorder');
