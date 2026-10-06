import { describe, expect, it, vi } from 'vitest';
import type { CloneRequest } from '../../../packages/modules/project/src/domain/ports/git-cloner.port';
import { CloneProjectWorkflow } from '../../../packages/modules/project/src/application/clone-project.workflow';
import { asProjectId } from '@platform/shared-kernel';
import { afterEach } from 'vitest';
import { currentDatabase } from '../../support/sqlite';
import { Project } from '../../../packages/modules/project/src/domain/entities/project.entity';
import { SqliteProjectRepository } from '../../../packages/modules/project/src/infrastructure/persistence/sqlite/project.repository.impl';
import {
  FakeBaselineManager,
  noGitCredentials,
  RecordingBroadcaster,
  fixedClock,
  NOW,
} from '../../support/project-ports';
const databases: ReturnType<typeof currentDatabase>[] = [];
afterEach(() => databases.splice(0).forEach(({ sqlite }) => sqlite.close()));

describe('AC-PRJ-013.5: cancellation settles queued clones', () => {
  it('marks a queued project interrupted and never starts its clone', async () => {
    const database = currentDatabase();
    databases.push(database);
    const repo = new SqliteProjectRepository(database.db);
    for (const id of ['a', 'b', 'queued'])
      database.uow.run((tx) =>
        repo.saveSync(
          tx,
          Project.create({
            id: asProjectId(id),
            name: id,
            sourceType: 'git',
            repoUrl: 'https://example.test/repo.git',
            baselinePath: `/tmp/baseline/${id}`,
            now: NOW,
          }),
        ),
      );
    const requests: CloneRequest[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cloner = {
      clone: async (input: CloneRequest) => {
        requests.push(input);
        await gate;
      },
    };
    const ws = new RecordingBroadcaster();
    const workflow = new CloneProjectWorkflow(
      repo,
      database.uow,
      fixedClock(),
      cloner,
      new FakeBaselineManager(),
      ws,
      noGitCredentials,
    );
    workflow.enqueue('a');
    workflow.enqueue('b');
    workflow.enqueue('queued');
    expect(workflow.cancel('queued')).toBe(true);
    await vi.waitFor(async () =>
      expect((await repo.findById(asProjectId('queued')))?.cloneStatus).toBe('failed'),
    );
    expect((await repo.findById(asProjectId('queued')))?.cloneErrorCode).toBe('INTERRUPTED');
    expect(ws.events).toContainEqual({
      event: 'project.clone_progress',
      projectId: 'queued',
      phase: 'failed',
      errorCode: 'INTERRUPTED',
    });
    release?.();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(requests).toHaveLength(2);
    expect(workflow.cancel('queued')).toBe(false);
  });
});
