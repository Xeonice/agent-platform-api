import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { ErrorEnvelope } from '@platform/contracts';

/**
 * 把**任何**出线的异常归一成 `ErrorEnvelope`（10A §3）。
 *
 * ★ 为什么是 filter 而不是逐处改 `throw`：仓里有 26 处裸 Nest 异常
 * （`throw new NotFoundException('sandbox x not found')` 这类），它们出线的是
 * `{message, error, statusCode}` —— 前端 `isErrorEnvelope` 要求 `code`+`message`+
 * `retryable` 三者俱全，判定失败后整条替换成 `{code:'UNKNOWN', message:'请求失败（HTTP 404）'}`。
 * **后端那句指名道姓的话就此丢掉**。
 *
 * 逐个改 throw 是 26 次可以漏的机会，而且下一个人写 `throw new NotFoundException`
 * 时不会想起这条约定。filter 是**结构性**的：不管谁抛什么，出线前统一过一道。
 * 这与 `sideEffectFree` 由**位置**挣得、`atDoor` 在出口统一盖章（04 §5）是同一手法，
 * 只是用在传输层。
 */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorEnvelopeFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    // WS/MCP 走各自的协议（10A §5），本 filter 只管 HTTP。
    if (host.getType() !== 'http') throw exception;

    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const envelope = this.toEnvelope(exception, status);
    // traceId 由本层统一注入：10 §6.8 写它是"用户报障时报的那个"，
    // 而此前**一个响应都没带过**（openapi 还写成可选，三处口径三个样）。
    envelope.traceId = randomUUID();

    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} → ${String(status)} ${envelope.code} [${envelope.traceId}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
    res.status(status).json(envelope);
  }

  private toEnvelope(exception: unknown, status: number): ErrorEnvelope {
    if (exception instanceof HttpException) {
      const body: unknown = exception.getResponse();
      // ① 已经是完整信封（门口拒绝 doorRejection、zod 校验管道）⇒ 原样放行。
      //    这两条路径自己就知道 `sideEffectFree`，filter 不该插手。
      if (isEnvelope(body)) return { ...body };

      // ② 半个信封 `{code, message}`（如 agent-task 的 INVALID_ARTIFACT_NAME）⇒ 补 retryable。
      if (isPartialEnvelope(body)) {
        return { code: body.code, message: body.message, retryable: defaultRetryable(status) };
      }

      // ②' **只有 `code`，没有 message**（口令门四处就是这个形状）。
      //
      // ⚠️ 这一条是补上去的，因为缺了它的时候**已经给出的 `code` 会被整条丢掉**：
      // ① ② 都不匹配 ⇒ 落到 ③ ⇒ `codeForStatus(429)` 打回 `BAD_REQUEST`，
      // 而抛出点写的明明是 `PASSCODE_LOCKED`。真实表现：解锁页上一句
      // 「Http Exception」，HTTP 是 429、信封里却写着 `BAD_REQUEST` + `retryable: true`
      // ——三处口径全错，且**唯一说得清"到底哪儿不对"的那一位被丢在了传输层**。
      //
      // 判据是「body 里有没有 code」，不是「信封完不完整」：给了名字就必须让它活着出线，
      // 缺的两位补齐即可。`...body` 在前，保住随行字段（`retryAfterSec`、`sideEffectFree`
      // 这些只有抛出点知道的东西）。
      if (isPartialEnvelope(body) === false && hasCode(body)) {
        return {
          ...body,
          code: body.code,
          message: nestMessage(body) ?? exception.message,
          retryable:
            typeof body.retryable === 'boolean' ? body.retryable : defaultRetryable(status),
        };
      }

      // ③ 裸 Nest：`{message, error, statusCode}` 或纯字符串。
      //    message 一定要透传 —— 它往往是唯一说清"到底哪儿不对"的那句话。
      return {
        code: codeForStatus(status),
        message: nestMessage(body) ?? exception.message,
        retryable: defaultRetryable(status),
      };
    }

    // ④ 未捕获的非 HttpException：**不透传内部细节**（可能含路径/SQL/栈）。
    //    真正的信息进日志（上面按 traceId 记），用户拿 traceId 报障。
    return {
      code: 'INTERNAL',
      message: '服务内部错误，请稍后重试；报障时请提供 traceId',
      retryable: true,
    };
  }
}

function isEnvelope(v: unknown): v is ErrorEnvelope {
  return (
    typeof v === 'object' &&
    v !== null &&
    'code' in v &&
    typeof v.code === 'string' &&
    'message' in v &&
    typeof v.message === 'string' &&
    'retryable' in v &&
    typeof v.retryable === 'boolean'
  );
}

/**
 * 只判「有没有 `code`」——比 `isPartialEnvelope` 松一格，因为 `code` 才是承重的那一位：
 * 它是前端选文案、用户报障、错误码表对账（docs:check A5）共同认的那个名字。
 * message 缺了可以退回 Nest 的，`code` 丢了就没有第二个地方能补回来。
 */
function hasCode(v: unknown): v is { code: string } & Record<string, unknown> {
  return typeof v === 'object' && v !== null && 'code' in v && typeof v.code === 'string';
}

function isPartialEnvelope(v: unknown): v is { code: string; message: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    'code' in v &&
    typeof v.code === 'string' &&
    'message' in v &&
    typeof v.message === 'string'
  );
}

/** Nest 默认体是 `{message, error, statusCode}`；message 可能是 string 或 string[]。 */
function nestMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body;
  if (typeof body !== 'object' || body === null || !('message' in body)) return undefined;
  const m = body.message;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.filter((x): x is string => typeof x === 'string').join('；');
  return undefined;
}

/**
 * ⚠️ 只在**没有显式给过**时兜底，显式值一律优先。
 *
 * 4xx 是"这个请求本身不被接受"，原样重发必然同样被拒 —— 要变的是请求或它的前置条件，
 * 不是重试次数（与 `UnknownRuntimeError.retryable = false` 同理，04 §4）。
 * 408/429 是例外：它们说的正是"稍后再来"。
 */
function defaultRetryable(status: number): boolean {
  if (status === HttpStatus.REQUEST_TIMEOUT || status === HttpStatus.TOO_MANY_REQUESTS) return true;
  return status >= 500;
}

/**
 * ⚠️ **刻意不给 `sideEffectFree` 兜底**。它的语义是"平台没动过任何状态"，
 * 只有**位置**知道真假（门口 vs 已受理），传输层不知道。没标就是没标 ——
 * 前端按"不确定"处理，那比猜一个值安全得多：猜 true 会让本该给 [重试] 的失败
 * 变成"就地改配置"，用户的半成品沙箱就没人回收了。
 */
function codeForStatus(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHORIZED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'INVALID_STATE';
    case HttpStatus.PAYLOAD_TOO_LARGE:
      return 'PAYLOAD_TOO_LARGE';
    case HttpStatus.REQUEST_TIMEOUT:
      return 'TIMEOUT';
    case HttpStatus.INSUFFICIENT_STORAGE:
      return 'DISK_INSUFFICIENT';
    case HttpStatus.BAD_GATEWAY:
      return 'UPSTREAM_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL' : 'BAD_REQUEST';
  }
}
