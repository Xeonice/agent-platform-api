import type { BaselineGit } from '../domain/ports/baseline-git.port';
import type { Project } from '../domain/entities/project.entity';

/**
 * The branches a project can offer, from its LOCAL baseline (03 §7.2★).
 *
 * ONE function because it has TWO callers that must never disagree:
 * `GET /api/projects/:id/branches` (what the picker shows) and the create door's
 * `branch` validation (what the platform accepts). If the two computed the set
 * differently, a value the UI offered could be refused — the exact failure mode the
 * door check exists to prevent.
 *
 * A non-git or not-yet-`ready` project answers `[]` rather than throwing: there is no
 * repository on disk to read. That also makes the door's answer for such a project
 * correct by construction — every branch name is "not in `[]`", so it is refused, and
 * `PROJECT_NOT_READY` already covers the not-ready case ahead of it anyway.
 */
export async function listBaselineBranches(git: BaselineGit, project: Project): Promise<string[]> {
  if (project.sourceType !== 'git' || project.cloneStatus !== 'ready') return [];
  return git.listBranches(project.baselinePath);
}
