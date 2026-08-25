import { z } from 'zod';

/**
 * Unified error envelope (docs/backend/04 §4, shared/10 §6.8, 02 §6).
 * Non-2xx REST bodies and MCP tool errors both carry this shape.
 * `retryable` is a first-class field — the frontend renders [retry] off it,
 * not off the HTTP status code. `code` is NEVER absent (fallback 'INTERNAL').
 */
export const ErrorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  /**
   * `true` ⇒ this request was refused BEFORE it changed anything: nothing was
   * persisted, nothing entered scheduling, `provider.create` was never called
   * (04 §5 「创建前静态校验」). The two failures a user meets are not the same
   * failure, and only this field tells them apart:
   *   · side-effect free ⇒ nothing exists to retry, and nothing is listed —
   *     the frontend must correct the request IN PLACE and send it again;
   *   · otherwise ⇒ a half-made object may exist, and [retry] is the right
   *     offer.
   *
   * ⚠️ IT IS A FIRST-CLASS FIELD FOR THE SAME REASON `retryable` IS. The
   * frontend used to infer it from `httpStatus === 409`, and that proxy covered
   * exactly ONE of the four door rejections this platform has: `unknown
   * provider` (400), `invalid image reference` (400) and `unknown runtime`
   * (400) were all rendered as "creation failed, retry" — about requests that
   * created nothing. A status code is a transport fact; whether the platform
   * changed state is a platform fact, and only the platform can state it.
   *
   * ⚠️ OPTIONAL, AND ITS ABSENCE IS THE CONSERVATIVE READING. `undefined` means
   * "not stated", which every consumer MUST read as "there may have been side
   * effects" — i.e. exactly the behaviour that existed before this field did.
   * That is the whole reason it is not required: a required field would force
   * every one of the dozens of error paths to take a position it does not have,
   * and the one that guessed wrong would tell the user "nothing happened" about
   * a request that half-happened. Under-reporting degrades to the status quo;
   * over-reporting invents a lie.
   *
   * ⚠️ AND THAT DEFAULT IS NOT THEORETICAL — IT ALREADY SAVED THIS ROLLOUT.
   * Three of the four door rejections above did not emit an envelope at all
   * (bare `BadRequestException(string)` ⇒ Nest's `{statusCode,message,error}`),
   * which the frontend downgrades to `{code:'UNKNOWN', retryable:false}`. Had
   * the field been shipped without also fixing those throw sites, the frontend
   * would have read `undefined` there — and landed on today's behaviour, which
   * is wrong but not a lie. A required field, or a `true` default, would have
   * turned the same omission into "nothing was created" for requests nobody had
   * checked. Fail-quiet was designed in on purpose; keep it that way.
   */
  sideEffectFree: z.boolean().optional(),
  /**
   * 服务端日志关联；用户报障时报这个。
   *
   * ⚠️ **REST 上一定有，类型上仍是 optional —— 这不是疏漏。**
   * REST 侧由 `ErrorEnvelopeFilter` 在出线前统一注入（10A §3），一个都不会漏；
   * 但本 schema 是 REST 与 MCP **共用**的（10 §6.8「REST 与 MCP 同构」），
   * 而 MCP tool 走的是 `{content:[…]}`，不经那个 filter。
   * 标成 required 会对 MCP 那条路撒谎 —— 宁可类型宽一格，也不要一个"契约说有、
   * 实际没有"的字段（这个仓刚因为 `totalBytes` 那种幽灵字段吃过亏）。
   */
  traceId: z.string().optional(),
  details: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export const INTERNAL_ERROR_CODE = 'INTERNAL';
