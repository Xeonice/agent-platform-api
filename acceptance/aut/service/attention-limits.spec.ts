import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { asAutomationId } from '@platform/shared-kernel';
import type {
  CreateAutomationInput,
  ProjectDto,
  RetainedVolumeDto,
  SandboxFacade,
} from '@platform/contracts';
import type { ProjectApplicationService, RetainedVolumeService } from '@platform/project';
import { AutomationApplicationService } from '../../../packages/modules/automation/src/application/automation-application.service';
import { AutomationRun } from '../../../packages/modules/automation/src/domain/entities/automation-run.entity';
import {
  automationDatabase,
  RuleRepository,
  RunRepository,
  NoopAudit,
  RecordingEventBus,
  hourlyRule,
} from '../../support/automation-rig';

const NOW = new Date('2026-10-05T00:00:00Z');
const project: ProjectDto = {
  id: 'prj-aut',
  name: 'automation project',
  sourceType: 'empty',
  cloneStatus: 'ready',
  cloneErrorCode: null,
  taskCount: 0,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};
const input: CreateAutomationInput = {
  name: 'daily',
  runtime: 'codex',
  prompt: 'run tests',
  scheduleKind: 'daily',
  scheduleConfig: { time: '08:00' },
  timezone: 'UTC',
  timeoutMinutes: 120,
  artifactRetentionDays: 7,
};

function harness() {
  const database = automationDatabase();
  const rules = new RuleRepository(database.db);
  const runs = new RunRepository(database.db);
  const rule = hourlyRule('aut-1', NOW);
  database.uow.run((tx) => rules.saveSync(tx, rule));
  rules.saveLog.length = 0;
  const projects: Pick<ProjectApplicationService, 'get' | 'list'> = {
    get: async () => project,
    list: async () => [project],
  };
  const retained: Pick<RetainedVolumeService, 'list'> = { list: async () => [] };
  const sandboxes: SandboxFacade = {
    imageReferences: async () => {
      throw new Error('imageReferences not used in this scenario');
    },
    defaultCapacity: async () => ({
      remainingTasks: 3,
      registeredTasks: 0,
      maxTasks: 3,
      basis: 'test',
    }),
    credentialImpact: async () => ({ affectedTasks: [], preparingTasks: [] }),
    countByProject: async () => ({}),
    activeByProject: async () => [],
    deleteByProjectSync: () => [],
    removeProjectWorkspaces: async () => {},
  };
  const uow = database.uow;
  const audit = new NoopAudit();
  const service = new AutomationApplicationService(
    rules,
    runs,
    uow,
    new RecordingEventBus(),
    { now: () => new Date(NOW.getTime()) },
    { next: () => 'aut-generated' },
    audit,
    { deliver: async () => 'sent', test: async () => ({ ok: true, message: 'ok' }) },
    { read: async () => ({ content: '', offset: 0, totalBytes: 0, eof: true }) },
    projects as ProjectApplicationService,
    sandboxes,
    retained as RetainedVolumeService,
  );
  return { service, rules, runs, rule, projects, retained, sandboxes, uow, audit };
}

describe('automation application preconditions and deletion preview', () => {
  it.each(['cloning', 'failed'] as const)(
    'cannot create a rule for a %s project and performs no writes',
    async (cloneStatus) => {
      const h = harness();
      h.projects.get = async () => ({ ...project, cloneStatus });
      const transaction = vi.spyOn(h.uow, 'run');
      await expect(h.service.create(project.id, input)).rejects.toMatchObject({
        status: 409,
        response: { code: 'PROJECT_NOT_READY', sideEffectFree: true },
      });
      expect(transaction).not.toHaveBeenCalled();
      expect(h.audit.records).toHaveLength(0);
    },
  );

  it('keeps the project-not-found code rather than masking every project read failure', async () => {
    const h = harness();
    h.projects.get = async () => {
      throw new NotFoundException({ code: 'PROJECT_NOT_FOUND' });
    };
    await expect(h.service.create('missing', input)).rejects.toMatchObject({
      response: { code: 'PROJECT_NOT_FOUND' },
    });
    expect(h.rules.saveLog).toHaveLength(0);
  });

  it('returns all 42 runs, only live tasks of this rule, and only artifacts with its immutable source id', async () => {
    const h = harness();
    for (let index = 0; index < 42; index += 1) {
      const run = AutomationRun.pending(`run-${String(index)}`, h.rule.id, NOW);
      if (index === 0) run.markRunning('live-own', NOW);
      else run.finalize('success', NOW);
      h.uow.run((tx) => h.runs.saveSync(tx, run));
    }
    h.uow.run((tx) => h.rules.saveSync(tx, hourlyRule('aut-other', NOW)));
    h.rules.saveLog.length = 0;
    const other = AutomationRun.pending('run-other', asAutomationId('aut-other'), NOW);
    other.markRunning('live-other', NOW);
    h.uow.run((tx) => h.runs.saveSync(tx, other));
    h.runs.saveLog.length = 0;
    h.sandboxes.activeByProject = async () => [
      { id: 'live-own', name: 'running regression' },
      { id: 'live-other', name: 'unrelated task' },
    ];
    const artifact = (id: string, sourceAutomationId: string): RetainedVolumeDto => ({
      id,
      projectId: h.rule.projectId,
      source: 'automation-artifact',
      sourceAutomationId,
      sourceAutomationName: 'name at launch',
      retainedAt: NOW.toISOString(),
      retainUntil: '2026-10-12T00:00:00Z',
      diskBytes: 10,
      downloadBytes: 512,
    });
    h.retained.list = async () => [artifact('own', h.rule.id), artifact('other', 'aut-other')];
    expect(await h.service.deletionPreview(h.rule.id)).toEqual({
      runCount: 42,
      artifactCount: 1,
      runningTasks: [{ id: 'live-own', name: 'running regression' }],
    });
    expect(h.rules.saveLog).toHaveLength(0);
    expect(h.runs.saveLog).toHaveLength(0);
  });
});
