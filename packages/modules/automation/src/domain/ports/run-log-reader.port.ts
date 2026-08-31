/**
 * `GET /api/automations/runs/:runId/logs?offset=&limit=` 的取数端口（03 §8.6）。
 *
 * ★ **本轮的实现取向，与 03 §8.6 字面写法有一处偏差，值得单独说明。**
 * 03 §8.6 原本描述的是「自动化自己往
 * `data/logs/automation-runs/<runId>/output.log` 写一份」。但同一节自己立的第二条
 * 纪律是 **「正文只写一份」**，而 S6 已经把无头 Task 的日志**上提为 Task 口径**
 * （`data/logs/agent-tasks/<taskId>/{stdout,stderr}.jsonl`，13 §2.1.4）——自动化触发的
 * 就是一个标准无头 Task，它的字节已经落在那里了。再抄一份到 `automation-runs/` 下面
 * 等于同样的兆字节写第二遍，还多出一处会与另一处不一致的地方。
 *
 * 所以 `automation_runs.log_path` **存的是那份 Task 日志的绝对路径**，这个端口按字节
 * 区间读它。`automation_runs` 仍然是自动化自己的记录（03 §8.6 那句「automation 口径
 * 保留不动」保住了），只是它的 `log_path` 指过去而不是复制过来。
 *
 * ⚠️ 由此，03 §8.6 的「10MB × 3 分片轮转」由 **Task 侧**的落盘策略负责，
 * `automation_runs.log_bytes` 只是那份文件当时的体积（I-AUR-4 的 30MB 上限照旧在
 * `AutomationRun.attachLog` 里把关）。
 */
export interface RunLogSlice {
  /** UTF-8 文本。区间可能切在多字节字符中间，读实现负责不产出半个字符。 */
  content: string;
  /** 本片真正的起始字节（`offset` 缺席时 = `max(0, total - limit)`）。 */
  offset: number;
  totalBytes: number;
  /** 本片是否读到了文件末尾。 */
  eof: boolean;
}

export interface RunLogReader {
  /** `offset` 缺席 ⇒ **回末尾 `limit` 字节**（03 §8.6 的默认口径）。 */
  read(path: string, offset: number | undefined, limit: number): Promise<RunLogSlice>;
}

export const AUTOMATION_RUN_LOG_READER = Symbol('AutomationRunLogReader');
