/**
 * `TriggerDecision`（23 §11.3）—— 03 §8.2 决策表的**返回类型**。
 *
 * 判别联合而不是「一个 boolean + 一堆可空字段」：决策表的四行加 missed 一共产出五种
 * **互斥**的后续动作，每种带的数据都不一样（skip 带原因、retry 带时刻、fail 带码）。
 * 写成可空字段的结构体，调用方就必须自己记住「reason 只有 skip 时才有意义」，
 * 而编译器帮不上忙。
 */
export type SkipReason = 'PREVIOUS_RUNNING' | 'AUTH_EXPIRED';

export type TriggerDecision =
  /** 行 4：创建标准无头 Task。 */
  | { readonly kind: 'trigger' }
  /** 行 1 / 行 2：本次不跑，直接落一条终态 run。 */
  | { readonly kind: 'skip'; readonly reason: SkipReason }
  /** 行 3：资源不足，排队重试（**更新同一行 run**，I-AUR-2）。 */
  | { readonly kind: 'retry'; readonly at: Date }
  /** 行 3 的尽头：重试 5 次仍失败 ⇒ 终态 `failed`。 */
  | { readonly kind: 'fail'; readonly errorCode: 'RESOURCE_EXHAUSTED' }
  /** 宕机错过：记 `missed`、**不补跑**、直接推进到下一个未来时刻。 */
  | { readonly kind: 'missed' };

export const Decisions = {
  trigger: (): TriggerDecision => ({ kind: 'trigger' }),
  skip: (reason: SkipReason): TriggerDecision => ({ kind: 'skip', reason }),
  retry: (at: Date): TriggerDecision => ({ kind: 'retry', at }),
  fail: (): TriggerDecision => ({ kind: 'fail', errorCode: 'RESOURCE_EXHAUSTED' }),
  missed: (): TriggerDecision => ({ kind: 'missed' }),
} as const;
