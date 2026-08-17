import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CLOCK, UNIT_OF_WORK, asProjectId } from '@platform/shared-kernel';
import type { Clock, UnitOfWork } from '@platform/shared-kernel';
import { CREDENTIAL_FACADE, CredentialPreparationError } from '@platform/contracts';
import type { CredentialFacade, GitAuthContext, SandboxEventBroadcaster } from '@platform/contracts';
import { SANDBOX_EVENT_BROADCASTER } from '@platform/contracts';
import { RepoUrl } from '../domain/value-objects/repo-url.vo';
import { PROJECT_REPOSITORY } from '../domain/repositories/project.repository';
import type { ProjectRepository } from '../domain/repositories/project.repository';
import { GIT_CLONER } from '../domain/ports/git-cloner.port';
import type { CloneProgress, GitCloner } from '../domain/ports/git-cloner.port';
import { CloneError } from '../domain/ports/git-cloner.port';
import { BASELINE_MANAGER } from '../domain/ports/baseline-manager.port';
import type { BaselineManager } from '../domain/ports/baseline-manager.port';
import type { CloneErrorCode, Project } from '../domain/entities/project.entity';

const MAX_CONCURRENT_CLONES = 2;
const CLONE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap (03 §7.2)
const PROGRESS_THROTTLE_MS = 1000;

/**
 * Background clone orchestrator (docs/backend/03 §7.2). Runs in-process with a
 * concurrency cap of 2; per clone it enforces a 30-min hard timeout, supports
 * cancel (AbortSignal), throttles `--progress` to ~1/s into `project.clone_progress`
 * (pushed straight to /events, §7.4 §78), and classifies failures. On startup it
 * reaps clones left `cloning` by a crash → `failed`/INTERRUPTED (13 §3).
 */
@Injectable()
export class CloneProjectWorkflow implements OnApplicationBootstrap {
  private readonly logger = new Logger('CloneProjectWorkflow');
  private activeCount = 0;
  private readonly waiting: string[] = [];
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repo: ProjectRepository,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(GIT_CLONER) private readonly cloner: GitCloner,
    @Inject(BASELINE_MANAGER) private readonly baseline: BaselineManager,
    @Inject(SANDBOX_EVENT_BROADCASTER) private readonly broadcaster: SandboxEventBroadcaster,
    @Inject(CREDENTIAL_FACADE) private readonly credentials: CredentialFacade,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.reconcileInterrupted();
    } catch (e) {
      this.logger.warn(`interrupted-clone reconcile skipped: ${(e as Error).message}`);
    }
  }

  /** Schedule a background clone for a project already persisted as `cloning`. */
  enqueue(projectId: string): void {
    if (this.activeCount < MAX_CONCURRENT_CLONES) {
      this.activeCount++;
      void this.runClone(projectId);
    } else {
      this.waiting.push(projectId);
    }
  }

  /** Abort an in-flight clone; returns true if one was running. */
  cancel(projectId: string): boolean {
    const controller = this.controllers.get(projectId);
    if (controller) {
      controller.abort();
      return true;
    }
    // queued-but-not-started: drop it from the queue so it never runs.
    const idx = this.waiting.indexOf(projectId);
    if (idx >= 0) this.waiting.splice(idx, 1);
    return false;
  }

  private startNext(): void {
    this.activeCount--;
    const next = this.waiting.shift();
    if (next) {
      this.activeCount++;
      void this.runClone(next);
    }
  }

  private async runClone(projectId: string): Promise<void> {
    const project = await this.repo.findById(asProjectId(projectId));
    if (!project || project.cloneStatus !== 'cloning' || !project.repoUrl) {
      this.startNext();
      return;
    }
    const dest = project.baselinePath;
    const controller = new AbortController();
    this.controllers.set(projectId, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CLONE_TIMEOUT_MS);
    let lastEmit = 0;
    let auth: GitAuthContext | null = null;

    try {
      // Private-repo support (03 §7.3): pick a credential by URL protocol/host via
      // the cross-context facade. A hit whose host ∈ allowedHosts yields an opaque
      // handle we inject; otherwise (no credential / host not allowed) we clone as a
      // public repo. The workflow only ever holds the handle — never plaintext.
      auth = await this.prepareAuth(project.repoUrl);
      await this.baseline.removeDir(dest); // fresh dest (retry re-clones from scratch)
      await this.cloner.clone({
        repoUrl: project.repoUrl,
        repoBranch: project.repoBranch,
        destPath: dest,
        timeoutMs: CLONE_TIMEOUT_MS,
        signal: controller.signal,
        env: auth?.env,
        gitSshCommand: auth?.gitSshCommand,
        onProgress: (p: CloneProgress) => {
          const now = this.clock.now().getTime();
          if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
          lastEmit = now;
          this.broadcaster.broadcast({
            event: 'project.clone_progress',
            projectId,
            phase: 'cloning',
            percent: p.percent,
            receivedBytes: p.receivedBytes,
          });
        },
      });
      const sizeBytes = await this.baseline.directorySizeBytes(dest);
      this.mutate(projectId, (p) => p.markCloneReady(sizeBytes, this.clock.now()));
      this.broadcaster.broadcast({
        event: 'project.clone_progress',
        projectId,
        phase: 'done',
        percent: 100,
      });
    } catch (e) {
      const code = this.classifyFailure(e, timedOut, controller.signal.aborted);
      await this.baseline.removeDir(dest).catch(() => undefined);
      this.mutate(projectId, (p) => p.markCloneFailed(code, this.clock.now()));
      this.broadcaster.broadcast({
        event: 'project.clone_progress',
        projectId,
        phase: 'failed',
        errorCode: code,
      });
      this.logger.warn(`clone failed for project ${projectId}: ${code}`);
    } finally {
      if (auth) await auth.dispose().catch(() => undefined); // delete temp keyfile dir (03 §7.3)
      clearTimeout(timer);
      this.controllers.delete(projectId);
      this.startNext();
    }
  }

  /** Resolve a git-auth handle for the repo, or null to clone as a public repo. */
  private async prepareAuth(repoUrl: string): Promise<GitAuthContext | null> {
    let repo: RepoUrl;
    try {
      repo = RepoUrl.create(repoUrl);
    } catch {
      return null; // already validated at create time; be defensive
    }
    try {
      return await this.credentials.prepareGitAuth(repo.credentialKind(), repo.host(), repo.scheme());
    } catch (e) {
      if (e instanceof CredentialPreparationError) return null; // no cred / host not allowed
      throw e;
    }
  }

  private classifyFailure(e: unknown, timedOut: boolean, aborted: boolean): CloneErrorCode {
    if (e instanceof CloneError) return e.code;
    if (timedOut) return 'TIMEOUT';
    if (aborted) return 'INTERRUPTED';
    return 'CLONE_FAILED_NETWORK';
  }

  /** Load → apply → persist in one sync UoW; skip silently on an illegal move (race). */
  private mutate(projectId: string, apply: (p: Project) => void): void {
    void this.repo
      .findById(asProjectId(projectId))
      .then((project) => {
        if (!project) return;
        try {
          apply(project);
        } catch {
          return; // e.g. already cancelled/failed — nothing to persist
        }
        this.uow.run((tx) => this.repo.saveSync(tx, project));
      })
      .catch((e: unknown) => {
        this.logger.warn(`clone-status persist failed for ${projectId}: ${(e as Error).message}`);
      });
  }

  private async reconcileInterrupted(): Promise<void> {
    const all = await this.repo.findAll();
    for (const project of all) {
      if (project.cloneStatus !== 'cloning') continue;
      this.mutate(project.id, (p) => p.markCloneFailed('INTERRUPTED', this.clock.now()));
      this.broadcaster.broadcast({
        event: 'project.clone_progress',
        projectId: project.id,
        phase: 'failed',
        errorCode: 'INTERRUPTED',
      });
      this.logger.warn(`reaped interrupted clone: project ${project.id} → failed/INTERRUPTED`);
    }
  }
}
