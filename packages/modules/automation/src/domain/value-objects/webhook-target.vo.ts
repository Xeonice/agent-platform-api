import { AutomationInvariantError } from '../errors/automation-errors';

/** 13 §2.7.1 CHECK。domain 侧重新声明（不许 import contracts，01 §3）。 */
export type TriggerOn = 'failure' | 'success' | 'all';

/** run 进入终态时用来匹配 `triggerOn` 的结果口径。 */
export type RunOutcome = 'success' | 'failed' | 'timeout';

/**
 * `WebhookTarget`（23 §11.3）。
 *
 * ⚠️ **`matches()` 把 `timeout` 归进 failure**（03 §8.5 / P21-7 §3.2 的☐成功☐失败☐超时）。
 * 这一行是 T-AUT-30 的全部内容，也是这个值对象值得存在的理由：`triggerOn` 只有三个值，
 * 而结果有四种（含 skipped/missed 那两种压根不发），映射关系散在调用点上迟早分叉。
 *
 * ⛔ **URL 的 SSRF 谓词不在这里**：它要解析 DNS（03 §8.5「解析目标 IP」），是 IO。
 * 值对象只管「形状对不对」（scheme ∈ {http,https}），网络那一半在 infrastructure 的
 * `WebhookSender` 里，两者都在，缺一不可。
 */
export class WebhookTarget {
  private constructor(
    readonly url: string,
    readonly triggerOn: TriggerOn,
  ) {}

  static create(url: string, triggerOn: TriggerOn = 'failure'): WebhookTarget {
    const parsed = safeParse(url);
    if (!parsed) {
      throw new AutomationInvariantError(
        `webhook url '${url}' is not a valid absolute URL (I-AUT-6)`,
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AutomationInvariantError(
        `webhook url must be http/https, got '${parsed.protocol.replace(':', '')}' (I-AUT-6)`,
      );
    }
    return new WebhookTarget(url, triggerOn);
  }

  /** I-AUT-6 的另一半在调用点：`webhook` 为空时**根本不发**，不是发一条被过滤的。 */
  matches(outcome: RunOutcome): boolean {
    if (this.triggerOn === 'all') return true;
    if (this.triggerOn === 'success') return outcome === 'success';
    // 'failure' —— `timeout` 归入 failure 语义（03 §8.5）
    return outcome === 'failed' || outcome === 'timeout';
  }
}

function safeParse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
