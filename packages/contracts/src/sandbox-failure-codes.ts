import { SandboxProviderErrorCode } from './sandbox-provider.contract';
import { INSTALL_FAILED } from './runtime-install.port';
import { IMAGE_CONTRACT_VIOLATION } from './agent-session.port';
import { UNKNOWN_RUNTIME } from './runtime-adapter.contract';
import { WORKSPACE_PREPARE_FAILED, DISK_INSUFFICIENT } from './workspace-preparer.port';
import { INTERNAL_ERROR_CODE } from './errors';

/**
 * 一个 `failed` sandbox 允许携带的**全部**错误码（04 §4）。
 *
 * ⚠️ **这个集合以前只存在于一句注释里。** `provision-sandbox.workflow.ts` 的 `failureOf`
 * 写着「Every error the `starting` 段 can raise already carries a `code` from the 04 §4
 * closed set」，然后：
 *
 * ```ts
 * return { code: typeof raw === 'string' && raw !== '' ? raw : INTERNAL_ERROR_CODE, … };
 * ```
 *
 * ——**任何**带 `.code` 的对象的**任何**非空字符串都被当成平台错误码。Node 的 fs 错误正好
 * 带 `.code`，于是 `ENOSPC` / `ENOENT` / `EACCES` 被写进 `failureCode`、存进库、发上 WS。
 * 前端按码查 P22 §1 文案，词汇表里没有 `ENOSPC`，落到通用兜底。注释断言了一个闭集，代码
 * 没有校验它——**断言不是实现**。
 *
 * ⚠️ **由已有声明组合而成，不重新抄一遍字面量。** 抄一遍就会出现「集合里的拼法没有任何
 * 产出方在用」这种谁都发现不了的错位：那个码永远不会被放行，而它对应的失败会静默降级成
 * `INTERNAL`——正好是这个集合要防的病，换了个方向发作。
 *
 * 新增平台错误类时**必须**在这里登记。忘了不会静默：`failureOf` 拒绝一个码时打 `error`
 * 级日志（说明它读到的是什么），而不是悄悄换成 `INTERNAL`。
 */
export const SANDBOX_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.values(SandboxProviderErrorCode),
  INSTALL_FAILED,
  IMAGE_CONTRACT_VIOLATION,
  UNKNOWN_RUNTIME,
  WORKSPACE_PREPARE_FAILED,
  DISK_INSUFFICIENT,
  INTERNAL_ERROR_CODE,
]);

export function isSandboxFailureCode(value: unknown): value is string {
  return typeof value === 'string' && SANDBOX_FAILURE_CODES.has(value);
}

/**
 * 「这一发之所以没跑成，是因为**现在没有资源**」—— 决策表行 3 的码集合（03 §8.2）。
 *
 * ⚠️ **它与「失败」是两件事，而这个区分有真实后果。** 自动化侧对这两类的处置相反：
 * 资源不足 ⇒ 排队重试（24min × 5），**不动** `consecutive_failures`（I-AUT-1：不是规则
 * 的错）；真失败 ⇒ 计数 +1，攒够 3 次降频、10 次自动禁用（03 §8.4）。把「机器忙」记成
 * 「规则坏」，结果就是一台忙碌的机器会在一个下午之内把自己的自动化规则全部关掉。
 *
 * ⚠️ **两个成员，两条路径，缺一条就漏掉一半**：
 *   · `RESOURCE_EXHAUSTED` —— 创建那一刻同步抛（03 §3 互斥登记拒绝）；
 *   · `DISK_INSUFFICIENT`  —— 后台 provision 阶段才撞上（工作区复制时盘写满，03 §7.6）。
 * 只认前者，「另一半路径」上的容量失败照旧污染失败计数 —— 那正是本切片之前的状态。
 *
 * ⛔ `WORKSPACE_PREPARE_FAILED` **不在里面**：它是「工作区准备失败」的泛化码，涵盖权限、
 * 分支不存在、git 炸了等等，这些重试一百次也不会好。磁盘那一格早已有更具体的
 * `DISK_INSUFFICIENT`（`classifyWorkspacePrepareError` 就是干这个的），把泛化码一并算成
 * 「等资源」，会让一条真坏了的规则永远停在「已排队 n/5」上不报警。
 */
export const CAPACITY_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
  SandboxProviderErrorCode.RESOURCE_EXHAUSTED,
  DISK_INSUFFICIENT,
]);

export function isCapacityFailureCode(value: unknown): value is string {
  return typeof value === 'string' && CAPACITY_FAILURE_CODES.has(value);
}
