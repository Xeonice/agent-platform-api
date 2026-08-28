import { describe, it, expect } from 'vitest';
import { AuditQuerySchema, validationFailureEnvelope } from '../../src/index';

/**
 * `AuditQuerySchema.severity` —— **逗号分隔的多值**（10 §6.6.1）。
 *
 * 产品要的「仅告警」= `warn ∪ error`，等值过滤表达不了它：前端只能不带过滤拉回
 * 「最近 200 条」再在客户端裁，于是「告警在第 201 条」时用户看到的是
 * 「当前筛选无匹配记录」，读出来的结论是**「平台从没告警过」**。
 *
 * ⚠️ 这个文件钉的是**解析**那一半（服务端过滤的效果在
 * `apps/api/test/integration/audit-repository.spec.ts`，线格式与错误信封在
 * `apps/api/test/e2e/audit.e2e-spec.ts`）。分开是因为「去重」在 SQL 那一侧看不出来
 * ——`IN ('warn','warn')` 与 `IN ('warn')` 结果一模一样，只有在这里断言才有效。
 */
describe('AuditQuerySchema.severity 多值解析', () => {
  const severityOf = (qs: Record<string, string>): unknown => AuditQuerySchema.parse(qs).severity;

  it('逗号分隔 ⇒ 数组，顺序按用户给的来', () => {
    expect(severityOf({ severity: 'warn,error' })).toEqual(['warn', 'error']);
    expect(severityOf({ severity: 'error,warn' })).toEqual(['error', 'warn']);
  });

  it('单值仍然工作（向后兼容），结果是只有一项的数组', () => {
    expect(severityOf({ severity: 'error' })).toEqual(['error']);
  });

  it('重复值去重 —— 这一条只有在解析这一层才看得见', () => {
    // ⚠️ 变异：去掉 `new Set(...)` ⇒ 这里变成 ['warn','warn','error','warn']。
    // 而 SQL 那一侧 `IN ('warn','warn','error','warn')` 与去重后完全同结果，
    // 所以 repo / e2e 的任何一条都抓不到它。
    expect(severityOf({ severity: 'warn,warn,error,warn' })).toEqual(['warn', 'error']);
  });

  it('不传就是 undefined（不筛）', () => {
    expect(severityOf({})).toBeUndefined();
  });

  it('含非法值 ⇒ 解析失败，且信封里不回显用户提交的值', () => {
    const parsed = AuditQuerySchema.safeParse({ severity: 'warn,critical' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const envelope = validationFailureEnvelope(parsed.error.issues);
    expect(envelope.code).toBe('VALIDATION_FAILED');
    expect(envelope.retryable).toBe(false);
    // 出问题的是第 2 项，路径要能指到它 —— 「哪一个值不对」是用户改请求需要的信息。
    expect(envelope.details?.[0]?.path).toBe('severity[1]');
    // ⚠️ 但**值本身不许出现在信封里**（validation-envelope.ts 的纪律：信封会进前端
    // 渲染、进日志、进用户截图）。
    expect(JSON.stringify(envelope)).not.toContain('critical');
    // 取值集合来自 schema 常量，可以放心带上 —— 那正是用户要看的那一句。
    expect(envelope.details?.[0]?.message).toContain('info');
  });

  it('空串也是非法值，不会被当成「不筛」悄悄放过', () => {
    expect(AuditQuerySchema.safeParse({ severity: '' }).success).toBe(false);
  });
});
