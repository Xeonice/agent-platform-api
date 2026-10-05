import { describe, expect, it, afterEach, vi } from 'vitest';
import { asAutomationId, asProjectId } from '@platform/shared-kernel';
import { Schedule } from '../../../packages/modules/automation/src/domain/value-objects/schedule.vo';
import { Automation } from '../../../packages/modules/automation/src/domain/entities/automation.entity';
import { AutomationRun } from '../../../packages/modules/automation/src/domain/entities/automation-run.entity';
import { TriggerDecisionService } from '../../../packages/modules/automation/src/domain/services/trigger-decision.domain-service';

afterEach(() => vi.unstubAllEnvs());
const now = new Date('2026-10-05T08:00:00Z');
function rule() {
  return Automation.create({
    id: asAutomationId('aut'),
    projectId: asProjectId('p'),
    name: 'daily',
    runtimeId: 'codex',
    prompt: 'test',
    scheduleKind: 'daily',
    scheduleConfig: { time: '08:00' },
    timezone: 'UTC',
    timeoutMinutes: 120,
    artifactRetentionDays: 7,
    now,
  });
}
describe('automation wall-clock schedule and ordered trigger policy', () => {
  it('hourly next trigger is strictly later than an exact boundary', () => {
    expect(Schedule.create('hourly', { minute: 0 }, 'UTC').nextOccurrence(now).toISOString()).toBe(
      '2026-10-05T09:00:00.000Z',
    );
  });
  it('daily local time follows DST and ignores host TZ', () => {
    const schedule = Schedule.create('daily', { time: '08:00' }, 'America/New_York');
    expect(schedule.nextOccurrence(new Date('2026-03-07T14:00:00Z')).toISOString()).toBe(
      '2026-03-08T12:00:00.000Z',
    );
    vi.stubEnv('TZ', 'Asia/Shanghai');
    expect(schedule.nextOccurrence(new Date('2026-03-07T14:00:00Z')).toISOString()).toBe(
      '2026-03-08T12:00:00.000Z',
    );
  });
  it.each(['', 'UTC+8', 'invented/zone'])('rejects invalid named timezone %s', (zone) =>
    expect(() => Schedule.create('daily', { time: '08:00' }, zone)).toThrow(),
  );
  it('previous active task takes precedence over expired authorization', () => {
    const automation = rule();
    const previousRun = AutomationRun.pending('run', automation.id, now);
    previousRun.markRunning('task', now);
    expect(
      TriggerDecisionService.decide({
        automation,
        previousRun,
        previousTaskActive: true,
        credentialState: 'expired',
        schedulingDecision: 'ok',
        now,
      }),
    ).toMatchObject({ kind: 'skip', reason: 'PREVIOUS_RUNNING' });
  });
  it('expiring authorization remains usable while absent authorization skips', () => {
    const base = {
      automation: rule(),
      previousRun: null,
      previousTaskActive: false,
      schedulingDecision: 'ok' as const,
      now,
    };
    expect(TriggerDecisionService.decide({ ...base, credentialState: 'expiring' })).toEqual({
      kind: 'trigger',
    });
    expect(TriggerDecisionService.decide({ ...base, credentialState: 'none' })).toMatchObject({
      kind: 'skip',
      reason: 'AUTH_EXPIRED',
    });
  });
  it('resource retries stay on one run and stop after the fifth attempt', () => {
    const automation = rule();
    const previousRun = AutomationRun.pending('run', automation.id, now);
    const input = {
      automation,
      previousRun,
      previousTaskActive: false,
      credentialState: 'active' as const,
      schedulingDecision: 'resource-exhausted' as const,
      now,
    };
    expect(TriggerDecisionService.decide(input)).toMatchObject({
      kind: 'retry',
      at: new Date(now.getTime() + 24 * 60_000),
    });
    for (let attempt = 0; attempt < 5; attempt++) previousRun.queueRetry(now);
    expect(TriggerDecisionService.decide(input)).toMatchObject({ kind: 'fail' });
    expect(previousRun.id).toBe('run');
  });
});
