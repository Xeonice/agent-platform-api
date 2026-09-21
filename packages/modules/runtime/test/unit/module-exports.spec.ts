import { describe, it, expect } from 'vitest';
import { RuntimeModule } from '../../src/interface/runtime.module';
import { HelperContainerSession } from '../../src/infrastructure/helper/helper-container.session';

/**
 * 跨模块消费的 provider 必须在 `exports` 里 —— 漏一个，**api 直接起不来**。
 *
 * ── 它修的是什么（2026-09-22 真机上炸过一次）────────────────────────────────
 * `AuthHelperCheck`（在 `platform/system`）依赖 `HelperContainerSession`（在本模块）。
 * 我把它加进了 `providers` 却漏了 `exports`，结果：
 *
 *     Nest can't resolve dependencies of AuthHelperCheck (index 0)
 *     ⇒ 容器 restarting，compose 报 `dependency failed to start ... is unhealthy`
 *
 * ⚠️⚠️ **而单元测试一条都没红。** 那些用例把 session 整个 mock 掉了 ——
 * 它们测的是 helper 的逻辑，**DI 接线从来没被执行过**。e2e 会抓到（它真的装 AppModule），
 * 但 e2e 要 docker-in-docker、跑一次很贵，不适合每次改动都等它。
 *
 * ⇒ 这条用例就是那个便宜的中间档：只读模块元数据，毫秒级，却能钉住「导出没掉」。
 * ⛔ 它不能替代 e2e（构造函数参数对不对、循环依赖有没有，它都看不见）。
 */
describe('RuntimeModule：跨模块消费的 provider 必须导出', () => {
  it('⭐ HelperContainerSession 在 exports 里 —— 漏了 api 起不来', () => {
    const exports: unknown = Reflect.getMetadata('exports', RuntimeModule);
    expect(Array.isArray(exports)).toBe(true);
    // MUTATION: 从 runtime.module.ts 的 exports 里删掉它 ⇒ 本条红（而此前只有真机会红）。
    expect(exports as unknown[]).toContain(HelperContainerSession);
  });
});
