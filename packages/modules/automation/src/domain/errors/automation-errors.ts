/**
 * automation 上下文的领域错误（23 §11）。
 *
 * ⚠️ **三个类而不是一个**，因为接口层要把它们翻译成**三种不同的 HTTP**，而
 * 「哪一种」是领域知道、传输层不知道的事：
 *   · `AutomationInvariantError` → 400（请求内容不合不变量：非法时区、prompt 超长）
 *   · `AutomationLimitError`     → 409（每项目 ≤20，I-AUT-7；不是请求内容不对，是名额满了）
 *   · `AutomationRunStateError`  → 409（run 的状态机/只读违规，I-AUR-1/2/3/4）
 * 合成一个之后，超上限会被报成 400「参数不合法」，而用户能做的其实是先删一条旧规则。
 */
export class AutomationInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationInvariantError';
  }
}

export class AutomationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationLimitError';
  }
}

export class AutomationRunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationRunStateError';
  }
}
