import { describe, it, expect } from 'vitest';
import type { ConnectivityResult } from '@platform/contracts';
import {
  outboundVerdict,
  perTargetBudget,
} from '../../../src/platform/system/diagnostics/checks/outbound-network.check';
import { DIAGNOSE_TIMEOUT_MS } from '../../../src/platform/system/diagnostics/diagnostics.service';

/**
 * ── 两层预算不许相等（2026-09-07 真机复现）───────────────────────────────────
 *
 * `DiagnosticsService` 把每一项 `check.run()` 与一个 `withTimeout(…, DIAGNOSE_TIMEOUT_MS)`
 * 赛跑。而外网连通那一项此前把**同一个** `ctx.timeoutMs` 原样当作**每个目标**的探测预算 ——
 * 于是只要有一个目标真的要用满预算，外层那个更早启动的计时器必然先到，这一项就永远只能是
 * 「5 秒内没有结果 —— 这一项没有结论」。
 *
 * ⚠️ 那恰恰**只在最需要答案的时候出现**：网好的时候三个目标 2 秒就回来了、结论好好的；
 * 网一出问题，用户想知道的正是「哪个不通」，而这一项在那一刻失声。
 */
describe('外网连通：单目标预算必须明显小于整项预算', () => {
  it('⭐ 不许等于整项预算 —— 相等就是「内层永远说不出话」', () => {
    // MUTATION: `perTargetBudget` 改成 `(ms) => ms` ⇒ 本条红。
    expect(perTargetBudget(DIAGNOSE_TIMEOUT_MS)).toBeLessThan(DIAGNOSE_TIMEOUT_MS);
  });

  it('⭐ 要留得下**组装并回传结论**的余量（至少 20%）', () => {
    // ⚠️ 只断言「小于」不够：小 1 毫秒也满足，而那与相等没有实质区别。
    const budget = perTargetBudget(DIAGNOSE_TIMEOUT_MS);
    expect(DIAGNOSE_TIMEOUT_MS - budget).toBeGreaterThanOrEqual(DIAGNOSE_TIMEOUT_MS * 0.2);
  });

  it('小预算下不塌成 0 —— 一个 0ms 的探测等于「全部不可达」', () => {
    // ⛔ 按比例缩放在小值上会塌到几十毫秒，那会把每个目标都误报成不可达。
    expect(perTargetBudget(100)).toBeGreaterThanOrEqual(1_000);
  });

  it('按比例跟随，而不是写死一个数（整项预算改了它要跟着走）', () => {
    expect(perTargetBudget(20_000)).toBeGreaterThan(perTargetBudget(10_000));
  });
});

/**
 * ── 超时 ≠ 够不着（2026-09-07 真机）─────────────────────────────────────────
 *
 * 这一项此前把任何失败都写成「不可达」，模型 API 全失败就宣布「离线环境，Agent 将不可用」。
 * 而真机实测：同一个 `api.openai.com`，同一分钟内 TLS 握手在 **1.0s / 1.8s / 6.1s** 之间跳。
 * 一条抖动的链路会周期性越过探测预算 —— 用户看着能正常干活的机器被告知不可用，
 * 而那条红条还会驱动向导要求他确认「以离线模式继续」。
 */
describe('超时不宣布离线，够不着才宣布', () => {
  const t = (over: Partial<ConnectivityResult>): ConnectivityResult => ({
    target: 'api.example.com',
    ok: false,
    modelApi: true,
    ...over,
  });

  it('⭐ 模型 API 全部**超时** ⇒ warn，且明说「这不等于连不上」', () => {
    // MUTATION: 删掉 `modelApis.every(r => r.timedOut === true)` 那一支 ⇒ 本条红。
    const r = outboundVerdict([
      t({ target: 'api.openai.com', timedOut: true }),
      t({ target: 'api.anthropic.com', timedOut: true }),
    ]);
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('这不等于连不上');
    expect(r.summary, '⛔ 超时不许被说成不可达').not.toContain('不可达');
    expect(r.hint).toContain('重跑一次');
  });

  it('⭐ 模型 API **真的够不着**（非超时）⇒ 仍然 fail 并宣布离线', () => {
    // ⚠️ 反面同样要钉：一个「永远只报 warn」的实现会让真断网时没人被告知。
    const r = outboundVerdict([t({ target: 'api.openai.com' })]);
    expect(r.status).toBe('fail');
    expect(r.summary).toContain('Agent 将不可用');
    expect(r.summary).toContain('不可达');
  });

  it('混合（一个超时一个够不着）⇒ 按证据强的那个走，仍宣布离线', () => {
    const r = outboundVerdict([
      t({ target: 'api.openai.com', timedOut: true }),
      t({ target: 'api.anthropic.com' }),
    ]);
    expect(r.status).toBe('fail');
    // 两种失败各说各的,不合并成一句
    expect(r.summary).toContain('未在预算内应答');
    expect(r.summary).toContain('不可达');
  });

  it('只有镜像仓库超时 ⇒ 模型 API 正常,不该扯上 Agent 可用性', () => {
    const r = outboundVerdict([
      t({ target: 'api.openai.com', ok: true, latencyMs: 100 }),
      t({ target: 'ghcr.io', modelApi: false, timedOut: true }),
    ]);
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('Agent 可用');
    expect(r.summary).toContain('未在预算内应答');
  });
});
