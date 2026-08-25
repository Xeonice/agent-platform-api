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
