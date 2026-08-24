import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CLOCK, UNIT_OF_WORK, asProjectId } from '@platform/shared-kernel';
import type { Clock, UnitOfWork } from '@platform/shared-kernel';
import { CREDENTIAL_FACADE } from '@platform/contracts';
import type {
  CredentialFacade,
  GitAuthContext,
  SandboxEventBroadcaster,
} from '@platform/contracts';
import { SANDBOX_EVENT_BROADCASTER } from '@platform/contracts';
import { PROJECT_REPOSITORY } from '../domain/repositories/project.repository';
import type { ProjectRepository } from '../domain/repositories/project.repository';
import { GIT_CLONER } from '../domain/ports/git-cloner.port';
import type { CloneProgress, GitCloner } from '../domain/ports/git-cloner.port';
import { CloneError } from '../domain/ports/git-cloner.port';
import { BASELINE_MANAGER } from '../domain/ports/baseline-manager.port';
import type { BaselineManager } from '../domain/ports/baseline-manager.port';
import type { CloneErrorCode, Project } from '../domain/entities/project.entity';
import { prepareGitAuth } from './git-auth';

const MAX_CONCURRENT_CLONES = 2;
const CLONE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap (03 §7.2)
const PROGRESS_THROTTLE_MS = 1000;
/**
 * Free-space floor the target filesystem must clear BEFORE a clone starts
 * (03 §7.2★ 磁盘预检). Overridable with `CLONE_MIN_FREE_BYTES`.
 *
 * ⚠️ WHY A FLOOR AND NOT 「仓库体积 × N」. 03 §7.5 phrases the rule as 「剩余空间 < 需求」,
 * but the need is UNKNOWABLE before the clone: nothing has asked the remote how big it
 * is, and the only honest way to find out (`ls-remote` + a size API) is per-forge,
 * needs a credential, and reintroduces exactly the network dependency 03 §7.2★ just
 * removed. A floor is the part that can be checked truthfully, and it catches the case
 * that actually happens — a disk already at the brim before the full clone (now
 * potentially ten times the shallow size) makes it worse.
 */
const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1 GiB

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
      // 磁盘预检 (03 §7.2★): refuse BEFORE writing anything, so a doomed clone leaves
      // no half-written baseline dir to `rm -rf`. It runs FIRST — ahead of the
      // credential materialisation — because it is the cheapest check and it must not
      // decrypt a secret for a clone that cannot start.
      await this.assertDiskSpace(dest);
      // Private-repo support (03 §7.3): pick a credential by URL protocol/host via
      // the cross-context facade. A hit whose host ∈ allowedHosts yields an opaque
      // handle we inject; otherwise (no credential / host not allowed) we clone as a
      // public repo. The workflow only ever holds the handle — never plaintext.
      auth = await prepareGitAuth(this.credentials, project.repoUrl);
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
            stage: p.stage,
            percent: p.percent,
            objectsDone: p.objectsDone,
            objectsTotal: p.objectsTotal,
            receivedBytes: p.receivedBytes,
            bytesPerSecond: p.bytesPerSecond,
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

  /**
   * 磁盘预检 (03 §7.2★): the pre-write half of `DISK_INSUFFICIENT`.
   *
   * ⚠️ IT DOES NOT REPLACE THE stderr CLASSIFIER, AND THE TWO ARE NOT ALTERNATIVES.
   * This one catches 「一开始就不够」 — and only that. It cannot catch 「克隆途中别的进程把
   *盘吃满」, which is a race no pre-check can win, so `classifyCloneError`'s
   * `/enospc|no space left/` branch stays exactly where it is. Before the full clone
   * that after-the-fact branch was an edge case; a full history makes it ordinary, and
   * an ordinary failure deserves to be refused before it writes half a repository.
   */
  private async assertDiskSpace(destPath: string): Promise<void> {
    const minFree = minFreeBytes();
    const available = await this.baseline.availableBytes(destPath);
    if (available >= minFree) return;
    throw new CloneError(
      'DISK_INSUFFICIENT',
      `not enough free space to clone: ${String(available)} bytes available, ` +
        `${String(minFree)} required (CLONE_MIN_FREE_BYTES)`,
    );
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

/** `CLONE_MIN_FREE_BYTES` when it parses as a positive integer, else the default. */
function minFreeBytes(): number {
  const raw = process.env.CLONE_MIN_FREE_BYTES;
  if (raw === undefined) return DEFAULT_MIN_FREE_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_FREE_BYTES;
}
