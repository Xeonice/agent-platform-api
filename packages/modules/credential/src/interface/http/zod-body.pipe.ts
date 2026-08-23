import { BadRequestException } from '@nestjs/common';
import { createZodValidationPipe } from 'nestjs-zod';
import { validationFailureEnvelope } from '@platform/contracts';

/**
 * 参数级 zod 校验管道 —— 产出与全局管道**同一个**信封（04 §4 / shared/10 §6.8）。
 *
 * ── 为什么这里需要一只自己的管道 ──────────────────────────────────────────────────
 * `POST /api/credentials/git/test` 的请求体是**判别联合**（`GitTestRequestSchema`）。
 * `createZodDto` 造出来的基类实例类型会是个联合类型，`class X extends …` 接不住，所以这个
 * 端点没有 DTO 类可供全局管道反射（`design:paramtypes` 只拿得到 `Object`），只能在参数上
 * 显式挂 schema —— `dto/credential.dto.ts` 末尾那段注释说的就是这件事。
 *
 * ── 为什么它不是「第二套错误形状」 ────────────────────────────────────────────────
 * 信封由 `@platform/contracts` 的 `validationFailureEnvelope` **单点**生成，本文件与
 * `apps/api/src/bootstrap/validation.pipe.ts` 都只是把它塞进一个 400 —— 唯一的重复是这一行
 * 绑定，而绑定重复不了形状。之所以不共用后者：那是**应用组合根**里的东西，模块包不能反向
 * 依赖 app（01 分层 / eslint-plugin-boundaries）。
 *
 * ── `sideEffectFree: true` 同样是构造上成立的 ─────────────────────────────────────
 * 参数管道跑在 **controller 方法体之前**：没进 application service、没落库、没调外部。
 * 所以「这次请求在产生任何副作用之前就被拒」对这里抛出的每一条都成立，理由是**位置**而不是
 * 逐条判断（同 04 §4.1「位置换取，不是逐点标注」）。
 */
export const ZodBodyPipe = createZodValidationPipe({
  createValidationException: (error) =>
    new BadRequestException({ ...validationFailureEnvelope(error.issues), sideEffectFree: true }),
});
