import { describe, it, expect } from 'vitest';
import { asProjectId } from '@platform/shared-kernel';
import { ProjectDtoSchema } from '@platform/contracts';
import { ProjectMapper } from '../../src/application/dto/project.mapper';
import { Project } from '../../src/domain/entities/project.entity';
import { NOW, gitProject } from './_project-doubles';

const SYNCED_AT = new Date('2026-08-28T09:30:00.000Z');

/**
 * `ProjectDto` 补四个字段 (docs/shared/10 §7.3).
 *
 * ── WHAT CHANGED AND WHY IT IS NOT A REGRESSION ──────────────────────────────────
 * The previous rule was 「「来源」字段不对外展示（产品定案）——repoUrl 不入 DTO」, and this
 * repo restated it in three places (the zod schema header, the mapper header, an e2e
 * assertion). 10 §7.3 overturns it: the project's read-only bar must show the remote
 * and answer 「我的基线是什么时候的」 (P21-6), and after the switch to a full clone
 * (03 §7.2★) the baseline's SIZE is a number a user needs to see.
 *
 * All four values were ALREADY persisted — `projects.repo_url` / `repo_branch` /
 * `baseline_size_bytes` / `updated_at` (13 §2.2). Nothing new is stored; the mapper
 * simply stopped dropping them on the floor.
 *
 * MUTATION: delete any one of the four lines from `ProjectMapper.toDto` and a test
 * here goes red. (Before this file, deleting all four broke nothing but an e2e
 * assertion that asserted their ABSENCE.)
 */
describe('ProjectMapper projects the source + freshness fields (10 §7.3)', () => {
  it('a git project carries repoUrl / repoBranch / baselineSizeBytes / updatedAt', () => {
    const project = Project.create({
      id: asProjectId('prj-1'),
      name: 'demo',
      sourceType: 'git',
      repoUrl: 'https://example.com/org/repo.git',
      repoBranch: 'release/2.0',
      baselinePath: '/data/baselines/prj-1',
      now: NOW,
    });
    project.markCloneReady(4_096, NOW);
    project.syncBaseline(9_000, SYNCED_AT);

    const dto = ProjectMapper.toDto(project, 3);

    expect(dto.repoUrl).toBe('https://example.com/org/repo.git');
    expect(dto.repoBranch).toBe('release/2.0');
    expect(dto.baselineSizeBytes).toBe(9_000);
    // `updatedAt` is the answer to 「基线是什么时候的」 — the sync moment, not creation.
    expect(dto.updatedAt).toBe(SYNCED_AT.toISOString());
    expect(dto.taskCount).toBe(3);
    // and it is a valid wire shape, so codegen and the frontend see the same thing.
    expect(ProjectDtoSchema.safeParse(dto).success).toBe(true);
  });

  it('absent values are `undefined`, never `null` (the wire contract writes them `?:`)', () => {
    const empty = Project.create({
      id: asProjectId('prj-2'),
      name: 'empty',
      sourceType: 'empty',
      baselinePath: '/data/baselines/prj-2',
      now: NOW,
    });

    const dto = ProjectMapper.toDto(empty, 0);

    // JSON `null` would survive `?? '—'` in the frontend and render as 「null」 in the
    // project bar; `undefined` disappears from the JSON body entirely.
    expect(dto.repoUrl).toBeUndefined();
    expect(dto.repoBranch).toBeUndefined();
    expect(Object.hasOwn(JSON.parse(JSON.stringify(dto)) as object, 'repoUrl')).toBe(false);
    // an empty project's baseline is measured as 0 at creation, so this one IS present.
    expect(dto.baselineSizeBytes).toBe(0);
    expect(dto.updatedAt).toBe(NOW.toISOString());
  });

  it('a git project still cloning has no measured baseline yet', () => {
    const dto = ProjectMapper.toDto(gitProject('prj-3'), 0);
    expect(dto.cloneStatus).toBe('cloning');
    expect(dto.baselineSizeBytes).toBeUndefined();
    // …but the source is known from the moment the row is written.
    expect(dto.repoUrl).toBe('https://example.com/org/repo.git');
  });

  it('internal fields stay internal — a host path is not a wire value', () => {
    const dto = ProjectMapper.toDto(gitProject('prj-4'), 0);
    expect(dto).not.toHaveProperty('baselinePath');
    expect(dto).not.toHaveProperty('workspaceMode');
    // the schema is the enforcement, not the assertion above: an added key would fail
    // typecheck at the mapper, and this pins that the shipped shape has no extras.
    expect(Object.keys(dto).sort()).toEqual(
      [
        'baselineSizeBytes',
        'cloneErrorCode',
        'cloneStatus',
        'createdAt',
        'id',
        'name',
        'repoBranch',
        'repoUrl',
        'sourceType',
        'taskCount',
        'updatedAt',
      ].sort(),
    );
  });
});
