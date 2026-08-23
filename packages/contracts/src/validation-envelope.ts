import type { ZodIssue } from 'zod';
import type { ErrorEnvelope } from './errors';

/**
 * DTO 校验失败 → 统一错误信封（docs/backend/04 §4 / §4.1，shared/10 §6.8，02 §6.1）。
 *
 * ⚠️ 它存在的理由和「门口拒绝」那三条一模一样：**校验失败此前根本不产出信封**。
 * `nestjs-zod` 的 `ZodValidationPipe` 出线的是
 * `{ statusCode: 400, message: 'Validation failed', errors: [...] }` —— **没有 `code`、
 * 没有 `retryable`**。前端 `toApiError` 判定「不是信封」后整体替换成
 * `{ code: 'UNKNOWN', message: '请求失败（HTTP 400）', retryable: false }`。也就是说
 * **每个端点的每一次 DTO 校验失败**，用户看到的都是同一句「请求失败（HTTP 400）」——
 * 包括 `initialPrompt` 超过 8000 字符这种一句话就能说清、用户改一下就好的情况。
 * 后端知道是哪个字段、违反了哪条规则，而这些信息一次都没到过能据此行动的人眼前。
 *
 * 本文件是**框架无关**的那一半（04 §1「纯 TS，不依赖 NestJS」）：把 zod 的 issue 列表翻成
 * 信封。NestJS 侧的绑定（把信封塞进 400 异常）在各自的 interface 层，只有一行。
 */

/**
 * 稳定错误码（02 §6.1 / 04 §4.1 已登记）。
 *
 * 取 `VALIDATION_FAILED` 而不是 `INVALID_REQUEST` / `BAD_REQUEST`：本库既有的码都是
 * 「**具体哪条规矩没过**」（`UNKNOWN_PROVIDER` / `INVALID_IMAGE_REFERENCE` /
 * `UNSUPPORTED_CAPABILITY` / `PROJECT_NOT_READY`），而不是 HTTP 语义的复述；
 * `VALIDATION_FAILED` 说的正是「schema 校验这一关没过」，与 `INSTALL_FAILED` /
 * `CLONE_FAILED_*` 的 `<环节>_FAILED` 构词法一致。`BAD_REQUEST` 则只是把状态码
 * 重写了一遍，等于什么都没说。
 */
export const VALIDATION_FAILED_CODE = 'VALIDATION_FAILED';

/**
 * 逐项错误（shared/10 §6.8 的 `details?: Array<{ path?, code?, message }>`）。
 *
 * ⚠️⚠️ **只放「路径 + 规则 + 期望」，绝不放用户提交的值。** zod 的 issue 对象本身是**不能**
 * 原样透出的：
 *   · `invalid_enum_value` 带 `received: <原始值>`，且它的**默认 message 里就嵌着那个值**；
 *   · `invalid_literal` 带 `received: <原始值>`；
 *   · `invalid_union` 带 `unionErrors`，里面是整棵子 issue 树，同样含 `received`。
 * 而校验失败的字段恰恰最可能是**不该回显的东西**：`initialPrompt` 是用户写给 agent 的
 * 指令正文，`InlineGitTestSchema.secret` 是明文凭证，`type` 字段填错时 `received` 装的
 * 就是隔壁那个字段的值。信封会进前端渲染、进服务端日志、进用户截图发给我们——把明文顺着
 * 错误路径搬出去是最容易发生、也最难追回的一类泄漏。
 *
 * 所以本模块**逐个 issue code 白名单**地取字段，而不是 `{...issue}` 之后删几个：
 *   · `path` / `code` —— 结构信息，不含值；
 *   · `message` —— 由本模块**从 schema 侧的常量**（上限、枚举取值、期望类型名）生成，
 *     不使用 zod 的默认 message（见上，它可能嵌值）。
 * 唯一的例外是 `custom`（`.refine()`），那句话是**契约作者写的**、不是用户输入——纪律见
 * `ruleText` 里的注释。
 *
 * `invalid_type` 的 `expected` / `received` 是**类型名**（`'string'` / `'number'` /
 * `'undefined'`），不是值，因此可以放心带上——「类型应为 string，实际为 number」正是
 * 用户改请求需要的信息。
 */
export interface ValidationDetail extends Record<string, unknown> {
  /** 点号路径（`require.snapshot` / `env[3].key`）。根级问题不带这个键。 */
  path?: string;
  /** zod 的 issue code —— 「违反了哪一类规则」的机器可读形式。 */
  code: string;
  /** 人话规则 + 期望值。 */
  message: string;
}

/**
 * 把 zod 的 issue 列表翻成一个 `ErrorEnvelope`。
 *
 * `sideEffectFree` **不**在这里写——它取决于校验发生在哪一层（HTTP pipe / 别处），
 * 由调用方按自己那一层的结构事实表态。见 `apps/api/src/bootstrap/validation.pipe.ts`。
 */
export function validationFailureEnvelope(issues: readonly ZodIssue[]): ErrorEnvelope {
  const details = issues.map(toDetail);
  return {
    code: VALIDATION_FAILED_CODE,
    message: summarize(details),
    // 校验失败一律不可重试：原样再发一次必然被同一条规则拒掉。要变的是请求本身。
    // 同「门口拒绝一律 retryable:false」的理由（04 §4.1）：每按必败的 [重试] 比没有按钮更糟。
    retryable: false,
    ...(details.length > 0 ? { details } : {}),
  };
}

function toDetail(issue: ZodIssue): ValidationDetail {
  const path = formatPath(issue.path);
  return {
    ...(path === '' ? {} : { path }),
    code: issue.code,
    message: ruleText(issue),
  };
}

/** `['require','snapshot']` → `require.snapshot`；`['env',3,'key']` → `env[3].key`（10 §6.8）。 */
function formatPath(path: readonly (string | number)[]): string {
  return path.reduce<string>((acc, seg) => {
    if (typeof seg === 'number') return `${acc}[${String(seg)}]`;
    return acc === '' ? seg : `${acc}.${seg}`;
  }, '');
}

/**
 * 首条问题当主句，其余只报个数。
 *
 * 为什么不把每一条都拼进 `message`：这句话要**直接展示**（shared/10 §6.8），而且前端在
 * 创建语境下会把它嵌进「无法用当前配置创建：{message}。请调整配置后再试」——一句能读完的
 * 话才有用。完整清单在 `details` 里，一条不少。
 */
function summarize(details: readonly ValidationDetail[]): string {
  const first = details[0];
  if (first === undefined) return '请求参数校验失败';
  const subject = first.path === undefined ? '请求体' : `请求参数 ${first.path}`;
  const rest = details.length - 1;
  return `${subject} ${first.message}${rest > 0 ? `（另有 ${String(rest)} 处参数问题）` : ''}`;
}

/**
 * 一条 issue 的人话规则。**只读 schema 侧的常量**（上限/下限、枚举取值、期望类型名），
 * 不读用户提交的值——理由见 `ValidationDetail` 的注释。
 */
function ruleText(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      // `received` 是 zod 的**类型名**（'undefined' / 'number' / …），不是值。
      return issue.received === 'undefined'
        ? '缺少必填字段'
        : `类型应为 ${issue.expected}，实际为 ${issue.received}`;

    case 'invalid_literal':
      // 只说期望值（schema 常量），不说 `issue.received`（用户提交的原始值）。
      return `取值必须是 ${JSON.stringify(issue.expected)}`;

    case 'invalid_enum_value':
    case 'invalid_union_discriminator':
      // `options` 是 schema 声明的取值集合；`received` 同上，刻意丢弃。
      return `取值必须是 ${issue.options.map((o) => String(o)).join(' / ')} 之一`;

    case 'invalid_union':
      // 不展开 `unionErrors`：那是整棵子 issue 树，里面照样带 `received`。
      return '不满足任何一种允许的形状';

    case 'unrecognized_keys':
      // keys 是**字段名**（结构信息，等同路径），不是字段值。
      return `含平台不接受的字段：${issue.keys.join('、')}`;

    case 'invalid_string':
      return `格式不合法（要求：${describeStringRule(issue.validation)}）`;

    case 'too_small':
      return describeBound(issue.type, issue.minimum, issue.inclusive, issue.exact === true, 'min');

    case 'too_big':
      return describeBound(issue.type, issue.maximum, issue.inclusive, issue.exact === true, 'max');

    case 'not_multiple_of':
      return `必须是 ${String(issue.multipleOf)} 的倍数`;

    case 'not_finite':
      return '必须是有限数值';

    case 'invalid_date':
      return '不是合法日期';

    case 'custom':
      // ⚠️ 唯一透传 zod message 的分支，因为 `.refine()` 的这句话是**契约作者**写的服务端
      // 文案（同 `doorRejection(status, code, message)` 的 message），不是用户输入。
      // 纪律：契约里写 `.refine()` 时**不要把被校验的值插进 message**，否则就在这里破功。
      return issue.message;

    default:
      // `invalid_arguments` / `invalid_return_type` / `invalid_intersection_types` ——
      // 都是函数/交叉类型 schema 才会出现的，本平台的 wire schema 里没有。给个不撒谎的兜底。
      return `不满足校验规则（${issue.code}）`;
  }
}

function describeStringRule(
  validation: (ZodIssue & { code: 'invalid_string' })['validation'],
): string {
  if (typeof validation === 'string') return validation;
  if ('startsWith' in validation) return `以 ${JSON.stringify(validation.startsWith)} 开头`;
  if ('endsWith' in validation) return `以 ${JSON.stringify(validation.endsWith)} 结尾`;
  return `包含 ${JSON.stringify(validation.includes)}`;
}

/** `too_small` / `too_big` 的人话，按被校验的东西是字符串/数字/集合分开说。 */
function describeBound(
  type: 'string' | 'number' | 'array' | 'set' | 'date' | 'bigint',
  bound: number | bigint,
  inclusive: boolean,
  exact: boolean,
  side: 'min' | 'max',
): string {
  const n = String(bound);
  if (type === 'string') {
    if (exact) return `长度必须为 ${n} 字符`;
    if (side === 'min') return inclusive && bound === 1 ? '不能为空' : `长度不能少于 ${n} 字符`;
    return `长度超过上限 ${n} 字符`;
  }
  if (type === 'array' || type === 'set') {
    if (exact) return `必须正好 ${n} 项`;
    return side === 'min' ? `至少需要 ${n} 项` : `最多 ${n} 项`;
  }
  if (type === 'date') {
    return side === 'min' ? `日期不能早于 ${n}` : `日期不能晚于 ${n}`;
  }
  if (exact) return `必须等于 ${n}`;
  if (side === 'min') return inclusive ? `不能小于 ${n}` : `必须大于 ${n}`;
  return inclusive ? `不能大于 ${n}` : `必须小于 ${n}`;
}
