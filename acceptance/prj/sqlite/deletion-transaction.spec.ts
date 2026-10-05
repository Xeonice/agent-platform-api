import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { ConflictException } from '@nestjs/common';
import { asAutomationId, asProjectId, asRetainedVolumeId } from '@platform/shared-kernel';
import type { SandboxFacade } from '@platform/contracts';
import { ProjectApplicationService } from '../../../packages/modules/project/src/application/project-application.service';
import { ProjectFacadeAdapter } from '../../../packages/modules/project/src/application/project-facade.adapter';
import type { RetainedVolumeService } from '../../../packages/modules/project/src/application/retained-volume.service';
import { unused } from '../../support/strict-ports';
import { CloneProjectWorkflow } from '../../../packages/modules/project/src/application/clone-project.workflow';
import { SyncBaselineWorkflow } from '../../../packages/modules/project/src/application/sync-baseline.workflow';
import { SqliteProjectRepository } from '../../../packages/modules/project/src/infrastructure/persistence/sqlite/project.repository.impl';
import { SqliteRetainedVolumeRepository } from '../../../packages/modules/project/src/infrastructure/persistence/sqlite/retained-volume.repository.impl';
import { Project } from '../../../packages/modules/project/src/domain/entities/project.entity';
import { RetainedVolume } from '../../../packages/modules/project/src/domain/entities/retained-volume.entity';
import { Automation } from '../../../packages/modules/automation/src/domain/entities/automation.entity';
import { AutomationRun } from '../../../packages/modules/automation/src/domain/entities/automation-run.entity';
import { SqliteAutomationRepository } from '../../../packages/modules/automation/src/infrastructure/persistence/sqlite/automation.repository.impl';
import { SqliteAutomationRunRepository } from '../../../packages/modules/automation/src/infrastructure/persistence/sqlite/automation-run.repository.impl';
import { SqliteAutomationProjectCleanup } from '../../../packages/modules/automation/src/infrastructure/persistence/sqlite/automation-project-cleanup.adapter';
import { SqliteUnitOfWork } from '../../../apps/api/src/platform/persistence/unit-of-work.impl';
import {
  FakeBaselineManager,
  noGitCredentials,
  RecordingBaselineGit,
  RecordingBroadcaster,
  RecordingCloner,
  fixedClock,
  noopEvents,
  NOW,
} from '../../support/project-ports';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function harness() {
  const sqlite = new Database(':memory:');
  databases.push(sqlite);
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite) as BetterSQLite3Database<Record<string, never>>;
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
  const repo = new SqliteProjectRepository(db);
  const uow = new SqliteUnitOfWork(sqlite);
  const baseline = new FakeBaselineManager();
  const git = new RecordingBaselineGit();
  const clock = fixedClock(NOW);
  const credentials = noGitCredentials;
  const cleanup = new SqliteAutomationProjectCleanup(db);
  const rules = new SqliteAutomationRepository(db);
  const runs = new SqliteAutomationRunRepository(db);
  const project = Project.create({
    id: asProjectId('prj-1'),
    name: 'test',
    sourceType: 'empty',
    baselinePath: '/data/baselines/prj-1',
    now: NOW,
  });
  const automation = Automation.create({
    id: asAutomationId('aut-1'),
    projectId: project.id,
    name: 'daily',
    runtimeId: 'codex',
    prompt: 'run',
    scheduleKind: 'daily',
    scheduleConfig: { time: '08:00' },
    timezone: 'UTC',
    timeoutMinutes: 120,
    artifactRetentionDays: 7,
    now: NOW,
  });
  const run = AutomationRun.pending('run-1', automation.id, NOW);
  uow.run((tx) => {
    repo.saveSync(tx, project);
    rules.saveSync(tx, automation);
    runs.saveSync(tx, run);
  });
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
    countByProject: async () => ({ 'prj-1': 3 }),
    activeByProject: async () => [],
    deleteByProjectSync: vi.fn(() => ['/data/workspaces/old']),
    removeProjectWorkspaces: vi.fn(async () => {}),
  };
  const volumes = new SqliteRetainedVolumeRepository(db);
  const service = new ProjectApplicationService(
    repo,
    uow,
    noopEvents,
    clock,
    { next: () => 'id' },
    baseline,
    git,
    sandboxes,
    volumes,
    new CloneProjectWorkflow(
      repo,
      uow,
      clock,
      new RecordingCloner(),
      baseline,
      new RecordingBroadcaster(),
      credentials,
    ),
    new SyncBaselineWorkflow(git, baseline, credentials, clock),
    cleanup,
  );
  return { sqlite, repo, baseline, rules, runs, sandboxes, service, volumes, uow };
}

it('a task create rechecks project existence in the reservation transaction after the project was deleted', async () => {
  const h = harness();
  const facade = new ProjectFacadeAdapter(
    h.repo,
    new RecordingBaselineGit(),
    unused<RetainedVolumeService>('unused retained service'),
  );
  expect((await facade.getRuntimeContextForTask('prj-1')).projectId).toBe('prj-1');
  await h.service.delete('prj-1');
  expect(() => h.uow.run((tx) => facade.assertCanCreateTaskSync(tx, 'prj-1'))).toThrow(
    expect.objectContaining({ code: 'PROJECT_NOT_FOUND' }),
  );
});

describe('project deletion commits metadata before deleting code (sev2 #2/#3)', () => {
  it('rules and full run history cascade in the same transaction as project deletion', async () => {
    const h = harness();
    for (let index = 0; index < 41; index += 1)
      h.uow.run((tx) =>
        h.runs.saveSync(
          tx,
          AutomationRun.pending(`extra-${String(index)}`, asAutomationId('aut-1'), NOW),
        ),
      );
    expect(await h.service.deletionPreview('prj-1')).toMatchObject({
      automationCount: 1,
      automationRunCount: 42,
      taskCount: 3,
    });
    await h.service.delete('prj-1');
    expect(await h.repo.findById(asProjectId('prj-1'))).toBeNull();
    expect(await h.rules.findById(asAutomationId('aut-1'))).toBeNull();
    expect(await h.runs.findById('run-1')).toBeNull();
    expect(await h.runs.countByAutomation(asAutomationId('aut-1'))).toBe(0);
    expect(h.baseline.removed).toEqual(['/data/baselines/prj-1']);
    expect(h.sandboxes.removeProjectWorkspaces).toHaveBeenCalledWith(['/data/workspaces/old']);
  });

  it('a late transaction failure rolls back project, rules and runs, leaving code untouched and returns 409', async () => {
    const h = harness();
    vi.spyOn(h.repo, 'deleteSync').mockImplementation(() => {
      throw new Error('foreign key conflict');
    });
    await expect(h.service.delete('prj-1')).rejects.toMatchObject({
      status: 409,
      response: { code: 'PROJECT_DELETE_CONFLICT' },
    });
    expect(await h.repo.findById(asProjectId('prj-1'))).not.toBeNull();
    expect(await h.rules.findById(asAutomationId('aut-1'))).not.toBeNull();
    expect(await h.runs.findById('run-1')).not.toBeNull();
    expect(h.baseline.removed).toEqual([]);
    expect(h.sandboxes.removeProjectWorkspaces).not.toHaveBeenCalled();
  });

  it('active tasks refuse deletion with a specific code before any mutation', async () => {
    const h = harness();
    h.sandboxes.activeByProject = async () => [{ id: 'running', name: 'do not delete' }];
    await expect(h.service.delete('prj-1')).rejects.toMatchObject({
      response: { code: 'PROJECT_HAS_ACTIVE_TASKS' },
    });
    expect(await h.rules.findById(asAutomationId('aut-1'))).not.toBeNull();
    expect(h.sandboxes.deleteByProjectSync).not.toHaveBeenCalled();
    expect(h.baseline.removed).toEqual([]);
  });

  it('an active task created after the preview is caught inside the transaction and rolls back rule deletion', async () => {
    const h = harness();
    h.sandboxes.deleteByProjectSync = () => {
      throw new ConflictException({ code: 'PROJECT_HAS_ACTIVE_TASKS' });
    };
    await expect(h.service.delete('prj-1')).rejects.toMatchObject({
      response: { code: 'PROJECT_HAS_ACTIVE_TASKS' },
    });
    expect(await h.rules.findById(asAutomationId('aut-1'))).not.toBeNull();
    expect(h.baseline.removed).toEqual([]);
  });
});

it('a retained artifact appearing after the preflight remains protected by the transactional foreign key', async () => {
  const h = harness();
  const volume = RetainedVolume.register({
    id: asRetainedVolumeId('rv-1'),
    projectId: asProjectId('prj-1'),
    sandboxId: 'finished',
    workspacePath: '/data/workspaces/finished',
    source: 'manual-destroy',
    retentionDays: 7,
    diskBytes: 10,
    downloadBytes: 10,
    now: NOW,
  });
  h.uow.run((tx) => h.volumes.saveSync(tx, volume));
  vi.spyOn(h.volumes, 'listByProject').mockResolvedValue([]); // preflight snapshot arrived before the artifact
  await expect(h.service.delete('prj-1')).rejects.toMatchObject({
    response: { code: 'PROJECT_DELETE_CONFLICT' },
  });
  expect(await h.volumes.findById(asRetainedVolumeId('rv-1'))).not.toBeNull();
  expect(await h.rules.findById(asAutomationId('aut-1'))).not.toBeNull();
  expect(h.baseline.removed).toEqual([]);
});
