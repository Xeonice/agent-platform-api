/**
 * DI token 单独一个文件:`logging.module.ts` 与 `platform-logger.service.ts`
 * 互相引用,token 放任一边都会形成 import 环。
 */

/** 落盘 writer（`RuntimeLogWriter` 实例）。 */
export const RUNTIME_LOG_WRITER = Symbol('RUNTIME_LOG_WRITER');
