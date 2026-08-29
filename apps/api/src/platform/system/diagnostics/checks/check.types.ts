import type { DiagnoseCheckId, DiagnoseStatus, PresetImageStep } from '@platform/contracts';

/** 一项检查的结论。`durationMs` 由调度方计时 —— 检查自己不该报自己的耗时。 */
export interface DiagnoseCheckResult {
  status: DiagnoseStatus;
  /** 一行人话，**自带这一次实测出来的具体数字**（哪个端口、被谁占、还剩多少 GB）。 */
  summary: string;
  /** 可复制的命令 / 配置项。⛔ 不要写「请检查网络」这种没有下一步的句子。 */
  hint?: string;
  step?: PresetImageStep;
  errorCode?: string;
  detail?: Record<string, unknown>;
}

export interface DiagnoseContext {
  /** 单项预算（ms）。检查内部的 IO **也**要吃这个预算，别只靠外层竞速。 */
  timeoutMs: number;
  /**
   * 客户端断开时 abort。
   *
   * ⚠️ 「断连即中止剩余检查」是契约的一部分（02 §5.3），而这只有在检查**看**这个信号
   * 时才成立 —— 外层 race 掉一个 promise 不会让底下那次 `fetch` 停下来，它会跑完、
   * 占着连接、也占着 5s。诊断是只读的，中止无副作用。
   */
  signal: AbortSignal;
}

/**
 * 一项诊断检查。
 *
 * ⚠️ **`id` 与 `label` 是静态的，因为首帧（`start`）要在任何一项跑完之前就发出去**
 * （SSE 契约 `DiagnoseStartFrame`）。把 label 做成 `run()` 的返回值，页面就画不出
 * 「未完成项 ⏳」的占位。
 *
 * ⚠️ **`run()` 不许抛。** 抛出来的那一项会变成整轮的失败，而 02 §5.3 写死了
 * 「一项卡住不阻塞整轮」—— 一项**炸掉**同理。调度方仍有兜底 catch（防御，不是设计），
 * 但把异常翻译成一句人话是检查自己的责任：它是唯一知道刚才在做什么的人。
 */
export interface DiagnoseCheck {
  readonly id: DiagnoseCheckId;
  readonly label: string;
  run(ctx: DiagnoseContext): Promise<DiagnoseCheckResult>;
}

export const DIAGNOSE_CHECKS = Symbol('DiagnoseChecks');

/** 字节 → 人看得懂的量级。诊断文案里到处要用，写一次。 */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v).toString() : v.toFixed(1)} ${units[i]!}`;
}
