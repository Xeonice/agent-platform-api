import { afterEach, describe, expect, it, vi } from 'vitest';
import { asProjectId } from '@platform/shared-kernel';
import { CloneProjectWorkflow } from '../../../packages/modules/project/src/application/clone-project.workflow';
import { Project } from '../../../packages/modules/project/src/domain/entities/project.entity';
import type { CloneRequest } from '../../../packages/modules/project/src/domain/ports/git-cloner.port';
import { SqliteProjectRepository } from '../../../packages/modules/project/src/infrastructure/persistence/sqlite/project.repository.impl';
import { currentDatabase } from '../../support/sqlite';
import {
  FakeBaselineManager,
  RecordingBroadcaster,
  noGitCredentials,
  fixedClock,
  NOW,
} from '../../support/project-ports';
import { deferred } from '../../support/strict-ports';

const databases: ReturnType<typeof currentDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.sqlite.close()));
describe('REQ-UPG-001/006 — accepted background clone drains before a writer handoff', () => {
  it('keeps a real cloning row and original operation live, refuses handoff without cancellation, then allows it after final DB commit', async () => {
    const db = currentDatabase();
    databases.push(db);
    const repo = new SqliteProjectRepository(db.db);
    const project = Project.create({
      id: asProjectId('original-clone'),
      name: 'original',
      sourceType: 'git',
      repoUrl: 'https://fixture.invalid/repo.git',
      baselinePath: '/isolated/clone/original',
      now: NOW,
    });
    db.uow.run((tx) => repo.saveSync(tx, project));
    const entered = deferred<CloneRequest>(),
      finish = deferred<void>();
    const cloner = {
      clone: async (input: CloneRequest) => {
        entered.resolve(input);
        await finish.promise;
      },
    };
    const broadcaster = new RecordingBroadcaster(),
      baseline = new FakeBaselineManager();
    const flow = new CloneProjectWorkflow(
      repo,
      db.uow,
      fixedClock(),
      cloner,
      baseline,
      broadcaster,
      noGitCredentials,
    );
    flow.enqueue(project.id);
    const operation = await entered.promise;
    expect(flow.pauseOwnership()).toBe(false);
    expect(operation.signal.aborted).toBe(false);
    expect((await repo.findById(project.id))!.cloneStatus).toBe('cloning');
    expect(
      broadcaster.events.some((event) => 'errorCode' in event && event.errorCode === 'INTERRUPTED'),
    ).toBe(false);
    finish.resolve();
    await vi.waitFor(async () =>
      expect((await repo.findById(project.id))!.cloneStatus).toBe('ready'),
    );
    await vi.waitFor(() => expect(flow.pauseOwnership()).toBe(true));
    expect(baseline.removed).toEqual([project.baselinePath]);
    expect(() => flow.enqueue('another-project')).toThrow('BACKGROUND_CLONE_WRITER_QUIESCED');
    flow.resumeOwnership();
    expect(flow.pauseOwnership()).toBe(true);
  });
});
