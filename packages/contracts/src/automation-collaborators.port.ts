import type { TimeoutMinutes } from './schemas/enums';
import type { CredentialStatus } from './schemas/runtime.schema';

/**
 * automation 上下文需要的三个**跨上下文出口**（26 §3 / 01 §5）。
 *
 * 它们住在 contracts 而不是各自的 module 里，理由与 `SANDBOX_FACADE` /
 * `RUNTIME_SETTINGS_READER` 完全一致：automation 要让 sandbox「按标准路径起一个无头
 * Task」并回答「那一发跑到哪了」，要问 runtime「这个 runtime 现在有没有能用的凭证」，
 * 还要问平台「访问口令启没启用」（SSRF 私网放行的前提，审计 P2-12）——三件事都不该让
 * automation 去 import 另外那些上下文的内部。
 */

// ---------------------------------------------------------------------------
// ① 无头 Task 出口（决策表行 4，03 §8.2）
// ---------------------------------------------------------------------------

export const AUTOMATION_TASK_LAUNCHER = Symbol('AutomationTaskLauncher');

export interface AutomationTaskLaunchInput {
  projectId: string;
  /** registry key。未注册 ⇒ 实现方按标准创建门的口径拒（`UNKNOWN_RUNTIME`，400）。 */
  runtimeId: string;
  prompt: string;
  timeoutMinutes: TimeoutMinutes;
  /** 起这一发的规则。用于日志与溯源，不改变创建语义。 */
  automationId: string;
}

/** 终态 Task 的结果面。`logPath` 是**可直接按字节区间读的文件**，不是目录。 */
export interface AutomationTaskOutcome {
  status: 'success' | 'failed' | 'timeout';
  /**
   * 平台侧的失败码（`sandboxes.failure_code` / `agent_tasks.error_code`），**闭集之外的
   * 一切都不该出现在这里**。
   *
   * ⚠️ **它专门为「决策表行 3 的另一半」而存在。** 容量不足有两条路径：创建那一刻同步
   * 抛（`AutomationResourceExhausted`，adapter 的 catch 认得），以及**后台 provision
   * 阶段**才撞上（最典型的是工作区复制时磁盘写满 ⇒ `DISK_INSUFFICIENT`）。第二条只能
   * 从相位机回来，而相位机此前只带 `errorMessage` —— 一个人类可读的字符串。于是那一半
   * 一律被记成「失败一次」，`consecutive_failures++`，最终把一条**只是排队等资源**的规则
   * 自动禁用（I-AUT-1 说这不是规则的错）。要分得开就必须有码，不能靠 grep 文案。
   */
  errorCode?: string;
  errorMessage?: string;
  logPath?: string;
  logBytes?: number;
}

/**
 * 一发自动化 Task 在**平台侧**的五个可观测相位。
 *
 * ⚠️ 之所以是「相位」而不是「起完就等回调」：创建沙箱是**异步**的（03：boxlite 冷拉
 * ~220s、冷装 CLI 实测 753s），而无头 Task 必须等沙箱真的 `running` 之后才能 POST
 * （`AgentTaskApplicationService.assertRunnable`）。用相位 + 每分钟重扫，整条链路的
 * 状态**全在库里**，进程重启接着走；用回调则那一段活在内存里，重启即丢。
 */
export type AutomationTaskPhase =
  /** 沙箱还在 provision（pending/scheduling/creating/starting/preparing-workspace）。 */
  | { readonly kind: 'provisioning' }
  /** 沙箱已 `running`，但还没起 Task —— 调用方该调 `startTask`。 */
  | { readonly kind: 'ready' }
  /** Task 在飞。 */
  | { readonly kind: 'running' }
  /** Task 落终态。 */
  | ({ readonly kind: 'finished' } & AutomationTaskOutcome)
  /** 沙箱记录没了 / 已 destroyed —— 这一发再也不会有结果。 */
  | { readonly kind: 'gone' };

/**
 * ⛔ **自动化层不得绕过任何一条状态机 / 配额 / 独立副本**（03 §8.2 行 4、P21-7 §9）。
 * 所以这三个动作的实现就是去调**人手动建 Task 时走的那同一个 application 方法**
 * —— 没有第二条更短的路，也不该有。
 */
export interface AutomationTaskLauncher {
  /**
   * 决策表**行 3** 的判据（03 §8.2「调度决策返回 `RESOURCE_EXHAUSTED`」）——
   * **只读**：不建任何东西、不登记任何配额、不落任何库。
   *
   * ⚠️ **它不是闸。** 唯一的闸是 `createSandbox` 里那段互斥登记（03 §3）：这里回答
   * `'ok'` 之后到真正创建之间，别人完全可能把最后一格用掉，那时 `createSandbox` 会照样
   * 抛 {@link AutomationResourceExhausted}。它存在只是为了让调度器在**还没写任何东西**
   * 的时候就把这一发记成「排队重试」而不是「失败一次」——两者对 `consecutive_failures`
   * 的影响相反（I-AUT-1）。
   *
   * ⚠️ **永不抛。** 判不出来（项目/镜像/runtime 有别的毛病）一律答 `'ok'`，把真正的
   * 错误留给 `createSandbox` 去产生 —— 在一个只回答「有没有资源」的问题上抛出「项目不
   * 存在」，会让调度器把这一轮整条规则跳过，而 `next_trigger_at` 已经推进了。
   */
  capacityFor(input: AutomationTaskLaunchInput): Promise<'ok' | 'resource-exhausted'>;
  /** 行 4 第一步：创建**标准无头** sandbox，返回它的 id（= Task id，23 D-1）。 */
  createSandbox(input: AutomationTaskLaunchInput): Promise<{ sandboxId: string }>;
  /** 行 4 第二步：沙箱 `running` 之后，按标准路径 POST 一个无头 Task。 */
  startTask(sandboxId: string, input: AutomationTaskLaunchInput): Promise<void>;
  /** 每轮扫描的观测点。沙箱不存在 ⇒ `{kind:'gone'}`（**不抛**）。 */
  phaseOf(sandboxId: string): Promise<AutomationTaskPhase>;
}

/**
 * 「现在没有资源起这一发」的跨上下文信号（决策表行 3）。
 *
 * ⚠️ **它必须是一个自己的类型，不能让调用方去嗅 HTTP 状态码或错误信封**。automation
 * 侧要区分的是「排队重试」与「记一次失败」，这两者对 `consecutive_failures` 的影响
 * 相反（I-AUT-1：资源不足不是规则的错）；靠 `e.getStatus() === 429` 判断等于把一条
 * 领域分支挂在传输层的巧合上。
 */
export class AutomationResourceExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationResourceExhausted';
  }
}

// ---------------------------------------------------------------------------
// ② 凭证态出口（决策表行 2，03 §8.2）
// ---------------------------------------------------------------------------

export const RUNTIME_CREDENTIAL_STATE_READER = Symbol('RuntimeCredentialStateReader');

/**
 * 只读一个聚合态，**绝不**碰明文。
 *
 * ⚠️ 与 `CredentialFacade.prepareRuntimeCredential` 刻意分开：那个口会解密并**物化**
 * 凭证，是注入路径；调度器每分钟对每条到期规则都要问一次「能不能起」，用注入口去问
 * 等于每分钟把凭证明文物化一遍来回答一个是非题。
 *
 * 未注册的 runtime / 没有 `runtime_settings` 行 / 选不出生效凭证 ⇒ `'none'`。
 */
export interface RuntimeCredentialStateReader {
  stateOf(runtimeId: string): Promise<CredentialStatus>;
}

// ---------------------------------------------------------------------------
// ③ 访问口令是否启用（SSRF 私网放行的前提，03 §8.5 / 审计 P2-12）
// ---------------------------------------------------------------------------

export const ACCESS_GATE_READER = Symbol('AccessGateReader');

/**
 * 11 §3.1 的访问口令启没启用。
 *
 * ⚠️ **缺席时按「没启用」读**，这是保守的那一边：没有这个 provider 的装配里，webhook
 * 对私网地址一律拒绝。反过来默认「启用了」会在一个没有门的部署里，把「能建规则的人」
 * 变成「能让平台向内网任意地址发 POST 的人」。
 */
export interface AccessGateReader {
  isEnabled(): boolean;
}
