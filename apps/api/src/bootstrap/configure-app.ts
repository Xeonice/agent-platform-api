import type { INestApplication } from '@nestjs/common';
import { platformValidationPipe } from './validation.pipe';
import { ErrorEnvelopeFilter } from './error-envelope.filter';

/**
 * 平台 app 的全局装配 —— **生产与测试共用这一个函数，这是它存在的全部理由。**
 *
 * ── 它修的是什么 ─────────────────────────────────────────────────────────────
 * 在此之前 `main.ts` 装三样（prefix / pipe / filter），而 **20 个 e2e 文件里有 19 个
 * 只装前两样**，各自手抄。少的那一样恰好是 `ErrorEnvelopeFilter`——**把错误响应归一
 * 成信封的那一层**。于是每个 e2e 断言的错误形状，都不是生产上会出现的那个形状。
 *
 * ⚠️ 这不是理论风险，它已经藏住过一个真缺陷。`passcode.e2e-spec.ts` 里一直写着
 *   `expect(locked.body.code).toBe('PASSCODE_LOCKED')`
 * 而口令门抛的是 `{ code: 'PASSCODE_LOCKED', retryAfterSec }`（有 code、无 message），
 * 经 filter 会被打回 `BAD_REQUEST` + `'Http Exception'`。同一份代码实测：
 *   e2e **不装** filter ⇒ 5 passed；e2e **装上** filter ⇒
 *   `expected 'BAD_REQUEST' to be 'PASSCODE_LOCKED'`。
 * **断言从头就在那儿，是 app 少装一层让它失效的**——用户因此在解锁页上看到
 * 一句「Http Exception」，而门禁全绿。
 *
 * ── 为什么是共用函数，而不是「记得也装上 filter」──────────────────────────
 * 手抄三行意味着 20 次可以漏的机会，而且下一个人复制的是他手边那份。
 * 共用一个函数之后，**生产与测试的装配偏差不再有地方存在**——这与
 * `session-cookie.ts` 把 cookie 属性收在一处、`passcode-errors.ts` 把三个信封收在
 * 一处是同一个手法：让不一致没有落脚点，而不是靠纪律去维持一致。
 *
 * ⚠️ WS/MCP 专用的 e2e（terminal-gateway、mcp-client 这些）**本来就不装**这三样，
 * 因为它们不走 REST 那条路。那是有意的差异，不在本函数管辖内。
 */
export function configurePlatformApp(app: INestApplication): void {
  // /api prefix so REST paths and openapi.json paths carry it (02 §8).
  app.setGlobalPrefix('api');
  // zod single source validation for every createZodDto DTO (02 §3); failures come
  // out as a real ErrorEnvelope (04 §4) — see bootstrap/validation.pipe.ts.
  app.useGlobalPipes(platformValidationPipe());
  // 10 §6.8 写着「所有非 2xx 响应一律是这个形状，**无例外**」——在此之前那句话不成立：
  // 26 处裸 Nest 异常出线的是 `{message,error,statusCode}`，前端认不出信封就把
  // 后端说的话整条替换成「请求失败（HTTP 404）」。这个 filter 是那句话的兑现（10A）。
  app.useGlobalFilters(new ErrorEnvelopeFilter());
}
