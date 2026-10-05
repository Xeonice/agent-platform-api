import { describe, expect, it, vi } from 'vitest';
import { asSandboxId } from '@platform/shared-kernel';
import { AutomationTaskLauncherAdapter } from '../../../packages/modules/sandbox/src/application/automation-task-launcher.adapter';
import { harness, waitForStatus } from '../../support/sandbox-rig';
function launcher(h: ReturnType<typeof harness>) {
  return new AutomationTaskLauncherAdapter(
    h.service,
    h.taskService,
    h.repo,
    h.taskRepo,
    h.clock,
    h.uow,
    h.events,
    h.projectFacade,
  );
}
describe('automation terminal outcome and retained artifact recovery', () => {
  it('a fresh watcher retries registration after teardown with its original rule and completion snapshot', async () => {
    const h = harness();
    const first = launcher(h);
    const { sandboxId } = await first.createSandbox({
      projectId: 'prj-1',
      runtimeId: 'claude-code',
      prompt: 'report',
      timeoutMinutes: 30,
      automationId: 'deleted-rule',
      automationName: 'Name before deletion',
      artifactRetentionDays: 7,
    });
    await waitForStatus(h.service, sandboxId, 'running');
    const task = await h.taskService.run(sandboxId, 'claude-code', {
      prompt: 'report',
      timeoutMinutes: 30,
    });
    [...h.provider.jobs.jobs.values()][0].finish(0);
    await vi.waitFor(async () =>
      expect((await h.taskService.get(sandboxId, task.id)).status).toBe('succeeded'),
    );
    const completedAt = h.clock.now();
    h.projectFacade.registerRetainedVolume = async () => {
      throw new Error('retained ledger offline');
    };
    await first.reconcileFinished();
    expect((await h.repo.findById(asSandboxId(sandboxId)))?.status).toBe('failed');
    expect(h.retainedRegistrations).toEqual([]);
    expect(await first.phaseOf(sandboxId)).toMatchObject({ kind: 'finished', status: 'success' });
    h.advanceClock(2 * 86_400_000);
    const restarted = launcher(h);
    h.projectFacade.registerRetainedVolume = async (command) => {
      h.retainedRegistrations.push(command);
    };
    await restarted.reconcileFinished();
    await restarted.reconcileFinished();
    expect(h.retainedRegistrations).toEqual([
      expect.objectContaining({
        source: 'automation-artifact',
        sourceAutomationId: 'deleted-rule',
        sourceAutomationName: 'Name before deletion',
        retentionDays: 7,
        retainedAt: completedAt,
      }),
    ]);
    expect(await restarted.phaseOf(sandboxId)).toMatchObject({
      kind: 'finished',
      status: 'success',
    });
    expect(h.provider.calls.filter((call) => call === 'destroy')).toHaveLength(2);
    expect((await h.repo.findById(asSandboxId(sandboxId)))?.status).toBe('destroyed');
  });
  it('failed preparation without a run keeps its actual error and cannot invent an artifact', async () => {
    const h = harness();
    h.workspace.prepare = async () => {
      throw new Error('workspace cannot be prepared');
    };
    const adapter = launcher(h);
    const { sandboxId } = await adapter.createSandbox({
      projectId: 'prj-1',
      runtimeId: 'claude-code',
      prompt: 'report',
      timeoutMinutes: 30,
      automationId: 'rule',
    });
    await waitForStatus(h.service, sandboxId, 'failed');
    const before = await adapter.phaseOf(sandboxId);
    expect(before).toMatchObject({ kind: 'finished', status: 'failed' });
    await adapter.reconcileFinished();
    expect(await adapter.phaseOf(sandboxId)).toEqual(before);
    expect(h.retainedRegistrations).toEqual([]);
    expect(h.wsCalls).toContain(`cleanup:${sandboxId}:false`);
  });
});
