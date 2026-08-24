import { describe, it, expect } from 'vitest';
import { asProjectId } from '@platform/shared-kernel';
import type { SandboxFacade } from '@platform/contracts';
import { ConflictException, HttpException } from '@nestjs/common';
import { ProjectApplicationService } from '../../src/application/project-application.service';
import { SyncBaselineWorkflow } from '../../src/application/sync-baseline.workflow';
import { CloneProjectWorkflow } from '../../src/application/clone-project.workflow';
import { CloneError } from '../../src/domain/ports/git-cloner.port';
import { Project } from '../../src/domain/entities/project.entity';
import {
  FakeBaselineManager,
  InMemoryProjectRepo,
  NoGitCredentialFacade,
  RecordingBaselineGit,
  RecordingBroadcaster,
  RecordingCloner,
  directUow,
  fixedClock,
  gitProject,
  noopEvents,
  NOW,
} from './_project-doubles';

const LATER = new Date('2026-08-28T12:00:00.000Z');
const noSandboxes: SandboxFacade = { countByProject: async () => ({}) };

function wire(now = LATER) {
  const repo = new InMemoryProjectRepo();
  const baseline = new FakeBaselineManager();
  const git = new RecordingBaselineGit();
  const clock = fixedClock(now);
  const credentials = new NoGitCredentialFacade();
  const cloneWorkflow = new CloneProjectWorkflow(
    repo,
    directUow,
    clock,
    new RecordingCloner(),
    baseline,
    new RecordingBroadcaster(),
    credentials,
  );
  const syncWorkflow = new SyncBaselineWorkflow(git, baseline, credentials, clock);
  const service = new ProjectApplicationService(
    repo,
    directUow,
    noopEvents,
    clock,
    { next: () => 'generated' },
    baseline,
    git,
    noSandboxes,
    cloneWorkflow,
    syncWorkflow,
  );
  return { service, repo, baseline, git, credentials };
}

function ready(repo: InMemoryProjectRepo, id = 'prj-1'): Project {
  const project = gitProject(id);
  project.markCloneReady(1_000, NOW);
  return repo.add(project);
}

/**
 * 基线同步 + 列分支 (docs/backend/03 §7.2★, 27 §3 `syncBaseline` / `listBranches`).
 *
 * ── THE MUTATIONS ────────────────────────────────────────────────────────────────
 *   ① point `fetchAll` at anything other than `project.baselinePath` → 「已有 Task 的
 *      工作区一律不动」 dies, and the test below that pins the fetched path goes red.
 *      That is the ONE invariant of this endpoint: a Task's workspace is a
 *      copy-on-write snapshot from ITS creation moment, so a sync that rewrote it
 *      would change the code under a run in progress.
 *   ② drop `project.assertCanSync()` from the workflow → a non-`ready` project reaches
 *      `git fetch` in a directory that may not even be a repository, and the 409 case
 *      turns into a 502 「网络错误」 about a project that simply has no remote.
 *   ③ make `listBranches` call the remote (`ls-remote`) or drop the empty-project
 *      short-circuit → the 「不碰网络、不需要凭证」 assertions go red.
 */
describe('POST /:id/sync — the smallest thing that unfreezes a baseline', () => {
  it('fetches into the BASELINE and refreshes size + updatedAt', async () => {
    const w = wire();
    const project = ready(w.repo);
    w.baseline.sizeBytes = 8_192;

    const dto = await w.service.syncBaseline('prj-1');

    // ① the ONLY path the fetch may touch. `workspaces/` is not merely absent from the
    //    assertion — `SyncBaselineWorkflow` holds no way to reach it at all.
    expect(w.git.fetched).toHaveLength(1);
    expect(w.git.fetched[0].repoPath).toBe(project.baselinePath);
    expect(w.git.fetched[0].repoPath).not.toContain('workspaces');
    // ② the two numbers the read-only bar shows afterwards.
    expect(dto.baselineSizeBytes).toBe(8_192);
    expect(dto.updatedAt).toBe(LATER.toISOString());
    // ③ nothing about the clone lifecycle moved.
    expect(dto.cloneStatus).toBe('ready');
  });

  it('a not-yet-ready project is refused BEFORE the fetch (409, not a git error)', async () => {
    const w = wire();
    w.repo.add(gitProject('prj-cloning')); // still `cloning`

    const e = await w.service
      .syncBaseline('prj-cloning')
      .then(() => null)
      .catch((err: unknown) => err);

    expect(e).toBeInstanceOf(ConflictException);
    expect(w.git.fetched).toEqual([]);
  });

  it('an empty project has no remote to sync ⇒ 409, and git is never run', async () => {
    const w = wire();
    const empty = Project.create({
      id: asProjectId('prj-empty'),
      name: 'empty',
      sourceType: 'empty',
      baselinePath: '/data/baselines/prj-empty',
      now: NOW,
    });
    w.repo.add(empty);

    await expect(w.service.syncBaseline('prj-empty')).rejects.toBeInstanceOf(ConflictException);
    expect(w.git.fetched).toEqual([]);
  });

  it('a failed fetch keeps its clone taxonomy code (the frontend already branches on it)', async () => {
    const w = wire();
    ready(w.repo);
    w.git.fetchError = new CloneError('CLONE_FAILED_PERMISSION', 'Authentication failed');

    const e = await w.service
      .syncBaseline('prj-1')
      .then(() => null)
      .catch((err: unknown) => err);

    expect(e).toBeInstanceOf(HttpException);
    expect((e as HttpException).getResponse()).toMatchObject({
      code: 'CLONE_FAILED_PERMISSION',
      // a permission failure is not fixed by pressing 重试 — the user must configure a
      // credential (03 §7.5's retryable column).
      retryable: false,
    });
    // the aggregate must NOT have recorded a successful sync.
    expect((await w.repo.findById('prj-1'))?.updatedAt).toEqual(NOW);
  });
});

describe('GET /:id/branches — local refs only (the full clone dividend)', () => {
  it('reads the BASELINE and never fetches', async () => {
    const w = wire();
    const project = ready(w.repo);
    w.git.branches = ['develop', 'main'];

    expect(await w.service.listBranches('prj-1')).toEqual(['develop', 'main']);
    expect(w.git.listed).toEqual([project.baselinePath]);
    // no `ls-remote`, no fetch, and therefore no git credential materialised.
    expect(w.git.fetched).toEqual([]);
    expect(w.credentials.disposals).toBe(0);
  });

  it('a still-cloning project answers [] rather than erroring', async () => {
    const w = wire();
    w.repo.add(gitProject('prj-cloning'));
    // 10 §6.2: the picker asks as soon as the page opens; 「暂时没有分支」 is the truthful
    // answer while the baseline does not exist yet, and it needs no special case in
    // the UI. Crucially, git is not invoked against a directory that has no repo.
    expect(await w.service.listBranches('prj-cloning')).toEqual([]);
    expect(w.git.listed).toEqual([]);
  });
});
