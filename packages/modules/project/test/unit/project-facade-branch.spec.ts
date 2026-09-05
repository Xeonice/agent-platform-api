import { describe, it, expect } from 'vitest';
import { asProjectId } from '@platform/shared-kernel';
import type { ProjectId } from '@platform/shared-kernel';
import { ProjectAccessError } from '@platform/contracts';
import { ProjectFacadeAdapter } from '../../src/application/project-facade.adapter';
import type { RetainedVolumeService } from '../../src/application/retained-volume.service';
import { unused } from '../../../../../test-support/unused';
import { Project } from '../../src/domain/entities/project.entity';
import type { ProjectRepository } from '../../src/domain/repositories/project.repository';
import type { BaselineGit, FetchRequest } from '../../src/domain/ports/baseline-git.port';

const NOW = new Date('2026-08-21T00:00:00.000Z');

/** Records every path it was asked about, so "did it go to the network?" is answerable. */
class FakeBaselineGit implements BaselineGit {
  readonly listed: string[] = [];
  readonly fetched: FetchRequest[] = [];
  constructor(private readonly branches: string[]) {}
  async listBranches(repoPath: string): Promise<string[]> {
    this.listed.push(repoPath);
    return this.branches;
  }
  async fetchAll(req: FetchRequest): Promise<void> {
    this.fetched.push(req);
  }
}

class OneProjectRepo implements ProjectRepository {
  constructor(private readonly project: Project | null) {}
  async findById(): Promise<Project | null> {
    return this.project;
  }
  async findByName(): Promise<Project | null> {
    return null;
  }
  async findAll(): Promise<Project[]> {
    return this.project ? [this.project] : [];
  }
  async count(): Promise<number> {
    return this.project ? 1 : 0;
  }
  saveSync(): void {}
  deleteSync(): void {}
}

function readyGitProject(id = 'prj-1'): Project {
  const p = Project.create({
    id: asProjectId(id) as ProjectId,
    name: 'demo',
    sourceType: 'git',
    repoUrl: 'https://example.com/x.git',
    baselinePath: `/baselines/${id}`,
    now: NOW,
  });
  p.markCloneReady(4096, NOW);
  return p;
}

/**
 * 分支在门口被校验 (docs/backend/03 §7.2★ / 10 §7.3).
 *
 * `create-door.spec.ts` proves the REJECTION is shaped correctly once it exists; this
 * file proves it exists at all, in the only component that can decide it — the project
 * context, which is the side that owns the baseline.
 *
 * MUTATION: delete the `if (branch !== undefined)` block in `ProjectFacadeAdapter` and
 * the first test goes red. Nothing else in the suite would: the door test injects its
 * `ProjectAccessError` through a seam, so it stays green against a facade that
 * validates nothing.
 */
/**
 * ⛔ **本组用例一次都不碰保留卷** —— 它验的是分支校验（03 §7.2★）。构造要求它在，
 * ⇒ 给一个**被调用就抛**的替身（`test-support/unused`）。这个参数是后来加的，
 * 而测试代码此前从未被 typecheck 看过，所以这四处一直漏着（2026-09-05 补）。
 */
const unusedRetainedVolumes = (): RetainedVolumeService =>
  unused<RetainedVolumeService>('RetainedVolumeService');

describe('the project facade validates the requested branch (03 §7.2★)', () => {
  it('a branch the baseline does not have ⇒ BRANCH_NOT_FOUND', async () => {
    const git = new FakeBaselineGit(['main', 'develop']);
    const facade = new ProjectFacadeAdapter(
      new OneProjectRepo(readyGitProject()),
      git,
      unusedRetainedVolumes(),
    );

    const e = await facade
      .getRuntimeContextForTask('prj-1', 'feature/x')
      .then(() => null)
      .catch((err: unknown) => err);

    expect(e).toBeInstanceOf(ProjectAccessError);
    expect((e as ProjectAccessError).code).toBe('BRANCH_NOT_FOUND');
    // …and it looked at the BASELINE to decide, which is what makes the check free:
    // local refs, no `ls-remote`, no git credential (the payoff of the full clone).
    expect(git.listed).toEqual(['/baselines/prj-1']);
    expect(git.fetched).toEqual([]);
  });

  it('a branch the baseline HAS is accepted and echoed into the runtime context', async () => {
    const git = new FakeBaselineGit(['main', 'develop']);
    const facade = new ProjectFacadeAdapter(
      new OneProjectRepo(readyGitProject()),
      git,
      unusedRetainedVolumes(),
    );

    const ctx = await facade.getRuntimeContextForTask('prj-1', 'develop');
    // echoed, not merely accepted: the workspace preparer downstream has no other way
    // to learn which branch to check out.
    expect(ctx.branch).toBe('develop');
    expect(ctx.baselinePath).toBe('/baselines/prj-1');
  });

  it('no branch requested ⇒ the baseline is never even read', async () => {
    const git = new FakeBaselineGit(['main']);
    const facade = new ProjectFacadeAdapter(
      new OneProjectRepo(readyGitProject()),
      git,
      unusedRetainedVolumes(),
    );

    const ctx = await facade.getRuntimeContextForTask('prj-1');
    expect(ctx.branch).toBeUndefined();
    // the overwhelmingly common create path must not pay for a git invocation it has
    // no use for.
    expect(git.listed).toEqual([]);
  });

  it('an EMPTY project offers no branches, so any branch is refused', async () => {
    const empty = Project.create({
      id: asProjectId('prj-empty') as ProjectId,
      name: 'empty',
      sourceType: 'empty',
      baselinePath: '/baselines/prj-empty',
      now: NOW,
    });
    // the double would happily answer with branches; the adapter must not ASK — there
    // is no repository in an empty project's baseline dir, so a `git branch -r` there
    // is an error, not an empty list.
    const git = new FakeBaselineGit(['main']);
    const facade = new ProjectFacadeAdapter(
      new OneProjectRepo(empty),
      git,
      unusedRetainedVolumes(),
    );

    const e = await facade
      .getRuntimeContextForTask('prj-empty', 'main')
      .then(() => null)
      .catch((err: unknown) => err);
    expect((e as ProjectAccessError).code).toBe('BRANCH_NOT_FOUND');
    expect(git.listed).toEqual([]);
  });
});
