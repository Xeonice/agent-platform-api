import { describe, expect, it } from 'vitest';
import { Schedule } from '../../src/domain/value-objects/schedule.vo';
import { TimeoutPolicy } from '../../src/domain/value-objects/policies.vo';
import { WebhookTarget } from '../../src/domain/value-objects/webhook-target.vo';
import { AutomationInvariantError } from '../../src/domain/errors/automation-errors';

/**
 * ★ **不变量错误必须带一个能查人话表的码。**
 *
 * 这些 message 是写给开发者的英文（`timezone 'UTC+8' is not an IANA time zone name
 * (I-AUT-9). Fixed-offset spellings…`、`timeout must be one of 30/60/120/240 minutes
 * (I-AUT-5), got 90`），一旦全部压成一个 `VALIDATION_FAILED`，前端就只剩「原样上屏」
 * 这一条路 —— 而「失败原因按 code 查人话表、不直接渲染 message」是本仓已裁决过的纪律
 * （`useProjectBranches.ts`）。
 *
 * ⛔ 这里断言的是**码**，不是文案：文案在前端，改文案不该让后端红。
 */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AutomationInvariantError);
    return (e as AutomationInvariantError).code;
  }
  throw new Error('expected a rejection');
}

describe('AutomationInvariantError 的业务码', () => {
  it("非 IANA 时区（'UTC+8' 这类固定偏移写法）→ INVALID_TIMEZONE", () => {
    expect(codeOf(() => Schedule.create('daily', { time: '08:00' }, 'UTC+8'))).toBe(
      'INVALID_TIMEZONE',
    );
    expect(codeOf(() => Schedule.create('daily', { time: '08:00' }, '  '))).toBe(
      'INVALID_TIMEZONE',
    );
  });

  it('超时不在四档里 → INVALID_TIMEOUT（与时区是两条不同的出路，⛔ 不共用一个码）', () => {
    expect(codeOf(() => TimeoutPolicy.of(90))).toBe('INVALID_TIMEOUT');
  });

  it('调度配置不合法 → INVALID_SCHEDULE', () => {
    expect(codeOf(() => Schedule.create('hourly', { minute: 77 }, 'Asia/Shanghai'))).toBe(
      'INVALID_SCHEDULE',
    );
    expect(codeOf(() => Schedule.create('daily', { time: '8am' }, 'Asia/Shanghai'))).toBe(
      'INVALID_SCHEDULE',
    );
    expect(codeOf(() => Schedule.create('weekly', { time: '08:00', days: [] }, 'UTC'))).toBe(
      'INVALID_SCHEDULE',
    );
  });

  it('webhook 地址不合法 → INVALID_WEBHOOK_URL', () => {
    expect(codeOf(() => WebhookTarget.create('not a url'))).toBe('INVALID_WEBHOOK_URL');
    expect(codeOf(() => WebhookTarget.create('ftp://example.com/hook'))).toBe(
      'INVALID_WEBHOOK_URL',
    );
  });

  it('没显式给码的抛出点仍是 VALIDATION_FAILED（默认值，旧行为一字不变）', () => {
    expect(new AutomationInvariantError('anything').code).toBe('VALIDATION_FAILED');
  });
});
