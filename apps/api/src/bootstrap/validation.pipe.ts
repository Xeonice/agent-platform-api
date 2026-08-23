import { BadRequestException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { createZodValidationPipe } from 'nestjs-zod';
import { validationFailureEnvelope } from '@platform/contracts';

/**
 * 平台的 zod 校验管道 —— **唯一**的全局校验接线（02 §3 zod 单一来源，04 §4 统一错误模型）。
 *
 * ── 它和 `nestjs-zod` 默认那只的差别 ──────────────────────────────────────────────
 * 默认 `ZodValidationPipe` 抛的是 `{ statusCode: 400, message: 'Validation failed',
 * errors: [...] }`：**没有 `code`、没有 `retryable`**，前端 `toApiError` 判定「不是信封」
 * 后整体替换成 `{ code:'UNKNOWN', message:'请求失败（HTTP 400）' }`。于是「哪个字段、
 * 违反了什么」这件后端一清二楚的事，一次都没到过用户眼前。这里换成产出真信封。
 *
 * ── 为什么 `sideEffectFree: true` 是**构造上**成立的，而不是逐条判断 ──────────────
 * pipe 跑在 **controller 之前**：请求还没进任何 application service，没落库、没进调度、
 * 没碰 `provider.create`。所以「这次请求在产生任何副作用之前就被拒」对**这里抛出的每一条**
 * 都成立，理由是**位置**，不是对某个字段的判断——与 `atDoor` 用位置换取标记同一套道理
 * （04 §4.1「位置换取，不是逐点标注」）。
 * 前端据此走「就地改请求再发」而不是「失败卡 + [重试]」（shared/10 §6.8）——对一次
 * 「指令超长」来说，这正是唯一有意义的呈现。
 *
 * ── 为什么必须是**一处**构造 ──────────────────────────────────────────────────────
 * 这只管道此前在仓里被 `new` 了 17 次：`main.ts` 一次 + 16 个 e2e 各自建 app 一次。
 * 只改 `main.ts` 的话，**生产用信封管道、e2e 用裸管道**——e2e 测的就不是线上跑的那只，
 * 变异防线整个失效。收敛成本文件后，那种不一致在结构上不可能再出现；
 * `suite-hygiene.e2e-spec.ts` 有一条机械守卫钉住「e2e 不许再 `new ZodValidationPipe`」。
 */
const PlatformZodValidationPipe = createZodValidationPipe({
  createValidationException: (error) =>
    new BadRequestException({ ...validationFailureEnvelope(error.issues), sideEffectFree: true }),
});

/**
 * 建一只全局校验管道。`main.ts` 与每个建 app 的 e2e 都必须用它，不要自己 `new`。
 */
export function platformValidationPipe(): PipeTransform {
  return new PlatformZodValidationPipe();
}
