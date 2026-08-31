import { describe, expect, it } from 'vitest';
import { asAutomationId } from '@platform/shared-kernel';
import { AutomationRun } from '../../src/domain/entities/automation-run.entity';
import { AutomationRunStateError } from '../../src/domain/errors/automation-errors';

/**
 * 独立聚合 `AutomationRun` —— 25 §3.7 的 T-AUR-1..4 与 T-AUT-40。
 *
 * ── 每组断言钉住的变异 ──────────────────────────────────────────────────────────
 *  ① `markRunning` 的合法前置态放宽到「任意」        ⇒ T-AUR-1 红
 *  ② `RetryPolicy.MAX_ATTEMPTS` 5 → 6               ⇒ T-AUR-2 红
 *  ③ `queueRetry` 改成 new 一条新 run                ⇒ T-AUT-40 红（同一 id、retryCount 递增）
 *  ④ `assertMutable` 去掉                            ⇒ T-AUR-3 红
 *  ⑤ `recordWebhookStatus` 也加上 `assertMutable`    ⇒ T-AUR-3 后半红
 *  ⑥ `LOG_BYTES_LIMIT` 放大                          ⇒ T-AUR-4 红
 *  ⑦ `RetryPolicy.INTERVAL_MS` 24min → 别的          ⇒「重试间隔 24 分钟」红
 */
const at = (s: string) => new Date(s);
const T0 = at('2026-06-01T00:00:00Z');
const AID = asAutomationId('aut-1');

describe('AutomationRun —— 状态机（I-AUR-1）', () => {
  it('T-AUR-1：pending → running → success 合法', () => {
    const run = AutomationRun.pending('run-1', AID, T0);
    expect(run.status).toBe('pending');
    expect(run.isTerminal).toBe(false);

    run.markRunning('sbx-1', at('2026-06-01T00:01:00Z'));
    expect(run.status).toBe('running');
    expect(run.sandboxId).toBe('sbx-1');
    expect(run.startedAt?.toISOString()).toBe('2026-06-01T00:01:00.000Z');

    run.finalize('success', at('2026-06-01T00:06:00Z'));
    expect(run.status).toBe('success');
    expect(run.isTerminal).toBe(true);
    // duration 从 startedAt 起算（不是 triggeredAt）：排队时间不算在执行时长里
    expect(run.durationSec).toBe(300);
  });

  it('T-AUR-1：running → running **非法**（重复起同一发）', () => {
    // ⚠️ 这一条与下面那条不重复：`success → running` 被「终态只读」（I-AUR-3）挡住，
    // 而 `running → running` 是**非终态**之间的非法转移 —— 只有 `markRunning` 自己的
    // 前置态判断能挡住它。少了那一句，一次重入的相位机会把 `startedAt` 与 `sandboxId`
    // 悄悄改掉，历史上那一发的开始时间就变成了第二次的。
    const run = AutomationRun.pending('run-1', AID, T0);
    run.markRunning('sbx-1', at('2026-06-01T00:01:00Z'));
    expect(() => run.markRunning('sbx-2', at('2026-06-01T00:02:00Z'))).toThrow(
      AutomationRunStateError,
    );
    expect(run.sandboxId).toBe('sbx-1');
    expect(run.startedAt?.toISOString()).toBe('2026-06-01T00:01:00.000Z');
  });

  it('T-AUR-1：success → running **非法**', () => {
    const run = AutomationRun.pending('run-1', AID, T0);
    run.markRunning('sbx-1', T0);
    run.finalize('success', T0);
    expect(() => run.markRunning('sbx-2', T0)).toThrow(AutomationRunStateError);
  });

  it('T-AUR-1：skipped / missed 是触发时刻直接落定的终态，不可再转', () => {
    const skipped = AutomationRun.skipped('run-s', AID, 'PREVIOUS_RUNNING', 'still running', T0);
    expect(skipped.isTerminal).toBe(true);
    expect(skipped.errorCode).toBe('PREVIOUS_RUNNING');
    expect(skipped.sandboxId).toBeNull();
    // 它们不参与失败计数，所以直接就是 outcome-applied（补扫扫不到）
    expect(skipped.outcomeApplied).toBe(true);
    expect(() => skipped.markRunning('sbx-1', T0)).toThrow(AutomationRunStateError);

    const missed = AutomationRun.missed('run-m', AID, 'downtime', T0);
    expect(missed.status).toBe('missed');
    expect(missed.isTerminal).toBe(true);
    expect(missed.outcomeApplied).toBe(true);
    expect(() => missed.finalize('failed', T0)).toThrow(AutomationRunStateError);
  });

  it('resource-exhausted **不是**终态（审计 P2-2）——它能继续转 running', () => {
    const run = AutomationRun.pending('run-1', AID, T0);
    run.queueRetry(T0);
    expect(run.status).toBe('resource-exhausted');
    expect(run.isTerminal).toBe(false);
    run.markRunning('sbx-1', at('2026-06-01T00:24:00Z'));
    expect(run.status).toBe('running');
  });
});

describe('AutomationRun —— 资源重试（I-AUR-2 / T-AUT-40）', () => {
  it('★ T-AUT-40：重试**更新同一行**（同一个 id），retryCount 递增，不新建记录', () => {
    const run = AutomationRun.pending('run-1', AID, T0);
    run.queueRetry(T0);
    expect(run.id).toBe('run-1');
    expect(run.retryCount).toBe(1);
    run.queueRetry(at('2026-06-01T00:24:00Z'));
    expect(run.id).toBe('run-1');
    expect(run.retryCount).toBe(2);
  });

  it('重试间隔是 24 分钟（03 §8.2 行 3）', () => {
    const run = AutomationRun.pending('run-1', AID, T0);
    run.queueRetry(T0);
    expect(run.retryAt?.toISOString()).toBe('2026-06-01T00:24:00.000Z');
    // `now` 那个 Date **没有被就地挪走**（shiftMs 是原地改的，这是踩过的坑）
    expect(T0.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('T-AUR-2：retryCount 到 5 之后再 retry → 拒（调用方据此转终态 failed）', () => {
    const run = AutomationRun.pending('run-1', AID, T0);
    for (let i = 0; i < 5; i += 1) run.queueRetry(T0);
    expect(run.retryCount).toBe(5);
    expect(() => run.queueRetry(T0)).toThrow(AutomationRunStateError);
  });

  it('markRunning 会清掉 retryAt —— 一条在跑的 run 不该还挂着「几点重试」', () => {
    const run = AutomationRun.pending('run-1', AID, T0);
    run.queueRetry(T0);
    expect(run.retryAt).not.toBeNull();
    run.markRunning('sbx-1', at('2026-06-01T00:24:00Z'));
    expect(run.retryAt).toBeNull();
  });
});

describe('AutomationRun —— append-only（I-AUR-3）与日志上限（I-AUR-4）', () => {
  it('★ T-AUR-3：终态 run 改 status/duration → 拒；改 webhookStatus → **允许**', () => {
    const run = AutomationRun.pending('run-1', AID, T0);
    run.markRunning('sbx-1', T0);
    run.finalize('failed', at('2026-06-01T00:05:00Z'), { errorMessage: 'boom' });

    expect(() => run.finalize('success', T0)).toThrow(AutomationRunStateError);
    expect(() => run.queueRetry(T0)).toThrow(AutomationRunStateError);
    expect(run.status).toBe('failed');
    expect(run.durationSec).toBe(300);

    // 唯一允许的后置补写
    run.recordWebhookStatus('failed');
    expect(run.webhookStatus).toBe('failed');
    run.recordWebhookStatus('sent');
    expect(run.webhookStatus).toBe('sent');
  });

  it('T-AUR-4：logBytes 超 30MB → 拒（10MB × 3 分片轮转上限）', () => {
    const run = AutomationRun.pending('run-1', AID, T0);
    expect(() => run.attachLog('/data/logs/x/stdout.jsonl', 31_457_281)).toThrow(
      AutomationRunStateError,
    );
    // 边界：正好 30MB 放行
    run.attachLog('/data/logs/x/stdout.jsonl', 31_457_280);
    expect(run.logBytes).toBe(31_457_280);
    expect(run.logPath).toBe('/data/logs/x/stdout.jsonl');
  });

  it('outcome_applied：默认 false（补扫看得见），markOutcomeApplied 之后 true', () => {
    const run = AutomationRun.pending('run-1', AID, T0);
    run.markRunning('sbx-1', T0);
    run.finalize('failed', T0);
    expect(run.outcomeApplied).toBe(false);
    run.markOutcomeApplied();
    expect(run.outcomeApplied).toBe(true);
  });
});
