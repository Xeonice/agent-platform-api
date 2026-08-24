import { Inject, Injectable } from '@nestjs/common';
import { CLOCK } from '@platform/shared-kernel';
import type { Clock } from '@platform/shared-kernel';
import { CREDENTIAL_FACADE } from '@platform/contracts';
import type { CredentialFacade, GitAuthContext } from '@platform/contracts';
import { BASELINE_GIT } from '../domain/ports/baseline-git.port';
import type { BaselineGit } from '../domain/ports/baseline-git.port';
import { BASELINE_MANAGER } from '../domain/ports/baseline-manager.port';
import type { BaselineManager } from '../domain/ports/baseline-manager.port';
import { CloneError } from '../domain/ports/git-cloner.port';
import type { Project } from '../domain/entities/project.entity';
import { prepareGitAuth } from './git-auth';

/**
 * Wall-clock cap on one `git fetch --all`. Much shorter than the clone's 30 min
 * because `POST /:id/sync` answers SYNCHRONOUSLY with the refreshed `ProjectDto`
 * (27 §3) — a request that could hang for half an hour is a different endpoint, and
 * a fetch into an existing baseline transfers only what changed.
 */
const SYNC_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 基线同步 (docs/backend/03 §7.2★ / 27 §3 `syncBaseline`).
 *
 * ── THE SCOPE IS THE POINT ───────────────────────────────────────────────────────
 * The baseline was frozen at creation: a project built a week ago served week-old code
 * forever, and the endpoint list had retry / convert-to-empty / cancel / delete but
 * nothing that said "fetch again". This adds the SMALLEST thing that fixes it —
 * `git fetch --all` plus a refreshed size and timestamp.
 *
 * ⚠️ IT MUST NOT TOUCH ANY EXISTING TASK'S WORKSPACE. Those are copy-on-write copies
 * taken when each Task was created; rewriting one changes the code under a run in
 * progress. That is why this workflow holds NO `WorkspacePreparer`, no sandbox
 * repository and no path under `workspaces/` — it cannot reach them, rather than
 * promising not to.
 *
 * Auto-sync (on a timer, or implicitly when a Task is created) is deliberately out of
 * scope, on the same reasoning as 「missed 不补跑」: the platform does not run long
 * operations the user cannot see it running.
 */
@Injectable()
export class SyncBaselineWorkflow {
  constructor(
    @Inject(BASELINE_GIT) private readonly git: BaselineGit,
    @Inject(BASELINE_MANAGER) private readonly baseline: BaselineManager,
    @Inject(CREDENTIAL_FACADE) private readonly credentials: CredentialFacade,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Fetch, re-measure, and apply the result to the aggregate. The caller persists —
   * this workflow owns the IO, the aggregate owns the invariants (`Project.syncBaseline`
   * re-asserts ready + git, so a race that flipped the project meanwhile still cannot
   * write a nonsense row).
   */
  async run(project: Project): Promise<void> {
    project.assertCanSync(); // refuse BEFORE the fetch — see `Project.assertCanSync`
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
    let auth: GitAuthContext | null = null;
    try {
      // `assertCanSync` above already established `sourceType === 'git'`, and I-PRJ-1
      // makes that imply a `repoUrl` — the `??` is a defensive floor, not a case: an
      // empty string simply resolves to "no credential", i.e. a public-repo fetch.
      auth = await prepareGitAuth(this.credentials, project.repoUrl ?? '');
      await this.git.fetchAll({
        repoPath: project.baselinePath,
        timeoutMs: SYNC_TIMEOUT_MS,
        signal: controller.signal,
        env: auth?.env,
        gitSshCommand: auth?.gitSshCommand,
      });
    } catch (e) {
      throw controller.signal.aborted ? new CloneError('TIMEOUT', 'baseline sync timed out') : e;
    } finally {
      if (auth) await auth.dispose().catch(() => undefined); // temp keyfile dir (03 §7.3)
      clearTimeout(timer);
    }
    const sizeBytes = await this.baseline.directorySizeBytes(project.baselinePath);
    project.syncBaseline(sizeBytes, this.clock.now());
  }
}
