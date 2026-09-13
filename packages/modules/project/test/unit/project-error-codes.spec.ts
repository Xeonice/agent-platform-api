import { describe, it, expect } from 'vitest';
import type { SandboxFacade } from '@platform/contracts';
import { HttpException } from '@nestjs/common';
import { ProjectApplicationService } from '../../src/application/project-application.service';
import { SyncBaselineWorkflow } from '../../src/application/sync-baseline.workflow';
import { CloneProjectWorkflow } from '../../src/application/clone-project.workflow';
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

/**
 * ★ **每一条 4xx 都必须带一个业务码。**
 *
 * 没有码的时候，`ErrorEnvelopeFilter` 只能按状态码兜底：`project limit reached (max 50)`
 * 与 `sourceType 'git' requires repoUrl` 都是 `BAD_REQUEST`，前端**没有任何东西可以分支**，
 * 于是把后端那句英文原样上屏。而「不许从状态码反推语义」这条本仓已经裁决过
 * （`useProjects.ts` 文件头）—— 语义只能由后端在信封里声明。
 *
 * 这一组用例钉的就是「码存在且稳定」这件事：⛔ 改码等于改契约，会让前端的人话表失配。
 */
const noSandboxes: SandboxFacade = { countByProject: async () => ({}) };

function wire() {
  const repo = new InMemoryProjectRepo();
  const baseline = new FakeBaselineManager();
  const git = new RecordingBaselineGit();
  const clock = fixedClock(NOW);
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
    new SyncBaselineWorkflow(git, baseline, credentials, clock),
  );
  return { service, repo };
}

/** 信封体（filter 会原样放行带 code 的体，见 `error-envelope.filter.ts` ①②'）。 */
function envelopeOf(e: unknown): { code?: string; message?: string } {
  expect(e).toBeInstanceOf(HttpException);
  const body = (e as HttpException).getResponse();
  return typeof body === 'object' && body !== null ? (body as { code?: string }) : {};
}

async function captureCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    return envelopeOf(e).code;
  }
  throw new Error('expected a rejection');
}

describe('project 4xx 都带业务码（10 §6.8）', () => {
  it('总数已达 50 → PROJECT_LIMIT_REACHED，⛔ 不是裸 400', async () => {
    const { service, repo } = wire();
    for (let i = 0; i < 50; i += 1) repo.add(gitProject(`prj-${String(i)}`));
    const code = await captureCode(() => service.create({ name: 'one more', sourceType: 'empty' }));
    // ⚠️ 与下面那条同为 400 —— 正是因此才必须靠码区分，状态码分不开它们。
    expect(code).toBe('PROJECT_LIMIT_REACHED');
  });

  it("sourceType 'git' 少了 repoUrl → INVALID_PROJECT_SOURCE（与上一条同为 400，码不同）", async () => {
    const { service } = wire();
    const code = await captureCode(() => service.create({ name: 'x', sourceType: 'git' }));
    expect(code).toBe('INVALID_PROJECT_SOURCE');
  });

  it('重名 → ALREADY_EXISTS（此前出线的是 filter 兜底的 INVALID_STATE，前端那条分支是死的）', async () => {
    const { service, repo } = wire();
    repo.add(gitProject('prj-1'));
    const code = await captureCode(() =>
      service.create({ name: 'project-prj-1', sourceType: 'empty' }),
    );
    expect(code).toBe('ALREADY_EXISTS');
  });

  it('项目不存在 → PROJECT_NOT_FOUND（⛔ 不是通用 NOT_FOUND：message 里只有一个 UUID）', async () => {
    const { service } = wire();
    expect(await captureCode(() => service.get('no-such'))).toBe('PROJECT_NOT_FOUND');
  });

  it('retry-clone 打在非 failed 项目上 → INVALID_STATE（409，调用点自己知道是哪个动作）', async () => {
    const { service, repo } = wire();
    const project: Project = gitProject('prj-1');
    project.markCloneReady(1_000, NOW);
    repo.add(project);
    expect(await captureCode(() => service.retryClone('prj-1'))).toBe('INVALID_STATE');
  });

  it('非法远端地址 → INVALID_REPO_URL', async () => {
    const { service } = wire();
    const code = await captureCode(() =>
      service.create({ name: 'x', sourceType: 'git', repoUrl: 'not a url' }),
    );
    expect(code).toBe('INVALID_REPO_URL');
  });
});
