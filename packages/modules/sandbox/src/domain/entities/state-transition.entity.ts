import type { SandboxStatus } from '../value-objects/sandbox-status.vo';

/**
 * Who triggered the transition (13 §2.1.2 CHECK, 5 values).
 *
 * ⚠️ **这是契约 `TRIGGERED_BY` 的第二份手抄，而且拆不掉**：`eslint-plugin-boundaries`
 * 禁止 domain 依赖 contracts（domain → shared-kernel only），所以这两份清单只能并存。
 *
 * 之所以写成**运行期数组再派生类型**，而不是直接写一个字面量联合：联合类型在运行期
 * 什么都不是，两份清单就只能靠人眼比对。有了数组，`triggered-by-parity.spec.ts` 才能
 * 把两边逐字比一遍——**把「记得同步」变成「不同步就红」**（同 A5 错误码对账的手法）。
 * 名字与契约那份**刻意取成一样的** `TRIGGERED_BY`：对账测试里两个同名 import 起别名摆在
 * 一起，谁多谁少一眼可见（`sandbox-status.vo` 的 `SANDBOX_STATUSES` 是同一个先例）。
 *
 * 此前唯一的对账点是 `audit.projector.ts` 底部 `transitionActor()` 的返回类型标注，
 * 但那是修 actor 漂移时的**副作用**：有人重构 projector 时顺手把它内联掉，两份清单就
 * 会重新开始悄悄漂移，而漂移的代价（前端 `ACTOR_LABELS` 在中文界面上漏英文标识符，
 * 且没有任何测试会红）那条注释里记着。
 */
export const TRIGGERED_BY = [
  'scheduler',
  'reaper',
  'user',
  'health-check',
  'provider-event',
] as const;

export type TriggeredBy = (typeof TRIGGERED_BY)[number];

/**
 * Append-only history inside the Sandbox aggregate (13 §2.1.2).
 * `from` is null for the very first record.
 */
export interface StateTransition {
  readonly from: SandboxStatus | null;
  readonly to: SandboxStatus;
  readonly at: Date;
  readonly triggeredBy: TriggeredBy;
}
