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
/**
 * `AutomationInvariantError` 出线时用的业务码（→ 400）。
 *
 * ★ **为什么不是一个 `VALIDATION_FAILED` 打天下**：这些 message 是给开发者读的英文
 *   （`timezone 'UTC+8' is not an IANA time zone name (I-AUT-9). Fixed-offset spellings…`），
 *   而前端的纪律是**按码查人话表、不直接渲染 message**（`useProjectBranches.ts` 已裁决）。
 *   全部塞进一个码，前端就只剩「把英文原样上屏」这一条路 —— 那正是这次要修掉的东西。
 *
 * ⚠️ 只给**用户在表单上能各自采取不同动作**的那几类单独开码；其余仍走
 *   `VALIDATION_FAILED`（前端一句通用「这条规则的配置不合法」即可），
 *   ⛔ 不要一字段一码 —— 那会让 10 §6.8 的码表变成表单字段清单。
 */
export type AutomationInvariantCode =
  | 'INVALID_TIMEZONE'
  | 'INVALID_TIMEOUT'
  | 'INVALID_SCHEDULE'
  | 'INVALID_WEBHOOK_URL'
  | 'VALIDATION_FAILED';

export class AutomationInvariantError extends Error {
  constructor(
    message: string,
    /** 默认 `VALIDATION_FAILED` —— 没显式给码的旧调用点行为一字不变。 */
    readonly code: AutomationInvariantCode = 'VALIDATION_FAILED',
  ) {
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
