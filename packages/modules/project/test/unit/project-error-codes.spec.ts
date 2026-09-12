import { describe, it, expect } from 'vitest';
import type { SandboxFacade } from '@platform/contracts';
import { HttpException } from '@nestjs/common';
import { ProjectApplicationService } from '../../src/application/project-application.service';
import { SyncBaselineWorkflow } from '../../src/application/sync-baseline.workflow';
import { CloneProjectWorkflow } from '../../src/application/clone-project.workflow';
import { Project } from '../../src/domain/entities/project.entity';
import { asProjectId, asRetainedVolumeId } from '@platform/shared-kernel';
import { RetainedVolume } from '../../src/domain/entities/retained-volume.entity';
import type { RetainedVolumeRepository } from '../../src/domain/repositories/retained-volume.repository';
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
  noRetainedVolumes,
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

function wire(volumes: RetainedVolumeRepository = noRetainedVolumes) {
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
    volumes,
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

/**
 * 删项目撞外键 —— 2026-09-11 实测确认的真 bug，这一组是它的回归闸门。
 *
 * ⚠️ **两条用例缺一不可，因为它们盯的是相反方向的失败**：
 *   · 「还在占盘的要拦」—— 防止把用户明确留下的成果连带删成孤儿；
 *   · 「已清理的不许拦」—— 这才是那个 bug 本身。`RetainedVolumeService.remove()` 是
 *     **软删**（记录留档审计，写在 controller 的 ApiOperation 里），行永不消失。
 *     DB 上那条 `onDelete: 'restrict'` 分不清「已清理」和「还在占盘」，于是
 *     **一个项目只要曾经有过一份保留成果，就再也删不掉了**，用户把成果清干净也没用。
 *     只补第一条会让这个 bug 原样活下来 —— 它当时就是"看起来有保护"的样子。
 */
describe('删项目 × 保留成果（I-RV × 项目删除）', () => {
  const volumeOf = (deletedAt: Date | null): RetainedVolume =>
    RetainedVolume.rehydrate({
      id: asRetainedVolumeId('rv-1'),
      projectId: asProjectId('p-1'),
      sandboxId: null,
      workspacePath: '/data/ws/rv-1',
      source: 'manual-destroy',
      diskBytes: 1024,
      downloadBytes: 512,
      retainedAt: NOW,
      retainUntil: new Date(NOW.getTime() + 86_400_000),
      deletedAt,
    });

  const repoWith = (vols: RetainedVolume[]): RetainedVolumeRepository => ({
    ...noRetainedVolumes,
    listByProject: () => Promise.resolve(vols),
  });

  it('⛔ 还在占盘的保留成果 ⇒ 409 INVALID_STATE，且文案要说出去哪儿清', async () => {
    const { service, repo } = wire(repoWith([volumeOf(null)]));
    repo.add(gitProject('p-1'));
    const e = await service.delete('p-1').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpException);
    const env = envelopeOf(e);
    expect(env.code).toBe('INVALID_STATE');
    // ⚠️ 断言「给了下一步」而不是断言整句：措辞会改，"不许只说删不掉"不会改（P22 §1）。
    expect(env.message).toMatch(/保留成果/);
    expect(env.message).toMatch(/清理|回收/);
    // 项目必须还在 —— 拒绝是 sideEffectFree 的。
    expect(await repo.findById(asProjectId('p-1'))).not.toBeNull();
  });

  it('⭐ 已清理（deletedAt 非空）的保留成果**不许**拦删项目 —— 这条就是那个 bug', async () => {
    const { service, repo } = wire(repoWith([volumeOf(NOW)]));
    repo.add(gitProject('p-1'));
    await expect(service.delete('p-1')).resolves.toBeUndefined();
    expect(await repo.findById(asProjectId('p-1'))).toBeNull();
  });
});
