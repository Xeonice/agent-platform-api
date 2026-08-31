/** webhook 载荷（03 §8.5「载荷」行，字段逐条对齐）。 */
export interface WebhookPayload {
  event: string;
  automationId: string;
  automationName: string;
  projectId: string;
  projectName: string;
  runtimeId: string;
  triggeredAt: string;
  finishedAt?: string;
  status: string;
  errorCode?: string;
  errorMessage?: string;
  /**
   * 「打开 Task」深链（`<publicBaseUrl>/?taskId=<sandboxId>`，P20 §8.3）。
   *
   * ⚠️ **`publicBaseUrl` 未配置时省略这个字段，而不是拼出一个错误链接**（T-AUT-33）。
   * 一条 `http://undefined/?taskId=…` 比没有链接更糟：它看起来可点。
   */
  taskUrl?: string;
}

export type WebhookDeliveryResult = 'sent' | 'failed' | 'skipped';

export interface WebhookTestOutcome {
  ok: boolean;
  errorCode?: 'VALIDATION_FAILED' | 'HOST_NOT_ALLOWED' | 'TIMEOUT' | 'UPSTREAM_UNAVAILABLE';
  message: string;
}

/**
 * 出站 webhook 端口（03 §8.5）。
 *
 * ⚠️ **`deliver` 永不抛**：投递失败绝不影响 run 本身的状态（通知是旁路）。它返回一个
 * 结果码，由调用方写进 `automation_runs.webhook_status`（I-AUR-3 唯一允许后置补写的
 * 字段）。把它写成会抛的接口，第一个忘记 try/catch 的调用点就会让一次成功的自动化
 * 因为对端 502 而被记成失败。
 */
export interface WebhookSender {
  deliver(url: string, payload: WebhookPayload): Promise<WebhookDeliveryResult>;
  /** `POST /api/automations/webhook-test` —— 同样的超时与 SSRF 规则，只发一条 `event:'test'`。 */
  test(url: string): Promise<WebhookTestOutcome>;
}

export const WEBHOOK_SENDER = Symbol('WebhookSender');
