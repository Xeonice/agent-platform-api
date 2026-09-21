import { describe, it, expect } from 'vitest';
import { DIAGNOSE_CHECK_IDS } from '@platform/contracts';
// ⚠️ 必须从**模块自己用的那个文件**取这个 token，不能从 contracts 取 ——
//    它是 `Symbol()`，两处各造一个就是两个不同的符号，find 永远不命中。
import { DIAGNOSE_CHECKS } from '../../../src/platform/system/diagnostics/checks/check.types';
import { SystemModule } from '../../../src/platform/system/system.module';

/**
 * 装配的检查项数必须等于契约项数 —— 漏一项，`/api/system/diagnose` **整个 500**。
 *
 * ── 它修的是什么（2026-09-22 真机上炸过一次）────────────────────────────────
 * 加第 ⑨ 项 `auth-helper` 时，我把它加进了 `providers` 却漏了 `DIAGNOSE_CHECKS` 的
 * `inject` 列表。`DiagnosticsService` 有运行期守卫，于是每次请求都抛：
 *
 *     诊断检查项与契约 DIAGNOSE_CHECK_IDS 对不上：缺 [auth-helper]，多 []
 *
 * ⚠️ **那道守卫是对的，但它只在请求时才响** —— 而「系统好像坏了」正是用户会去点
 * 诊断的时刻，此时它自己 500，等于在最需要它的时候把它关掉。
 * ⚠️ `diagnostics.service.spec.ts` 里那条「装配少一项 ⇒ 当场抛」测的是**服务的逻辑**，
 * 用的是合成替身 —— 它看不见**真实模块**的装配。
 *
 * ⇒ 这条只读模块元数据（毫秒级），把真实装配与契约钉在一起。
 */
describe('SystemModule：诊断项装配与契约同步', () => {
  it('⭐ DIAGNOSE_CHECKS 注入的项数 == 契约项数（漏一项 ⇒ 诊断端点整个 500）', () => {
    const providers = Reflect.getMetadata('providers', SystemModule) as unknown[];
    const entry = providers.find(
      (p): p is { provide: symbol; inject: unknown[] } =>
        typeof p === 'object' && p !== null && 'provide' in p && p.provide === DIAGNOSE_CHECKS,
    );
    expect(entry, 'SystemModule 里找不到 DIAGNOSE_CHECKS 这个 provider').toBeDefined();
    // MUTATION: 从 inject 列表里删掉任意一项 ⇒ 本条红（此前只有真机会红）。
    expect(entry!.inject).toHaveLength(DIAGNOSE_CHECK_IDS.length);
  });
});
