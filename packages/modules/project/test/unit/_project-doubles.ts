import { asProjectId } from '@platform/shared-kernel';
import type { Clock, EventBus, Tx, UnitOfWork } from '@platform/shared-kernel';
import { CredentialPreparationError } from '@platform/contracts';
import type {
  CredentialFacade,
  GitAuthContext,
  InjectableRuntimeCredential,
  RefreshableRuntimeCredential,
  SandboxEventBroadcaster,
  SandboxWsEvent,
} from '@platform/contracts';
import { Project } from '../../src/domain/entities/project.entity';
import type { ProjectRepository } from '../../src/domain/repositories/project.repository';
import type { BaselineManager } from '../../src/domain/ports/baseline-manager.port';
import type { BaselineGit, FetchRequest } from '../../src/domain/ports/baseline-git.port';
import type { CloneRequest, GitCloner } from '../../src/domain/ports/git-cloner.port';

/** Shared in-memory doubles for the project application tests (docs/backend/25). */

export const NOW = new Date('2026-08-21T00:00:00.000Z');

export class InMemoryProjectRepo implements ProjectRepository {
  readonly store = new Map<string, Project>();
  add(project: Project): Project {
    this.store.set(project.id as string, project);
    return project;
  }
  async findById(id: string): Promise<Project | null> {
    return this.store.get(id) ?? null;
  }
  async findByName(name: string): Promise<Project | null> {
    return [...this.store.values()].find((p) => p.name === name) ?? null;
  }
  async findAll(): Promise<Project[]> {
    return [...this.store.values()];
  }
  async count(): Promise<number> {
    return this.store.size;
  }
  saveSync(_tx: Tx, project: Project): void {
    this.store.set(project.id as string, project);
  }
  deleteSync(_tx: Tx, id: string): void {
    this.store.delete(id);
  }
}

/**
 * `availableBytes` is scriptable because it is the ONE input the 磁盘预检 branches on,
 * and it is not otherwise reachable from a test — a real `statfs` reports whatever the
 * runner's disk happens to hold, which is the definition of an untestable condition.
 */
export class FakeBaselineManager implements BaselineManager {
  readonly removed: string[] = [];
  readonly created: string[] = [];
  available = Number.POSITIVE_INFINITY;
  sizeBytes = 1024;
  async createEmptyDir(path: string): Promise<void> {
    this.created.push(path);
  }
  async removeDir(path: string): Promise<void> {
    this.removed.push(path);
  }
  async directorySizeBytes(): Promise<number> {
    return this.sizeBytes;
  }
  async availableBytes(): Promise<number> {
    return this.available;
  }
}

export class RecordingCloner implements GitCloner {
  readonly requests: CloneRequest[] = [];
  error?: Error;
  async clone(req: CloneRequest): Promise<void> {
    this.requests.push(req);
    if (this.error) throw this.error;
  }
}

export class RecordingBaselineGit implements BaselineGit {
  readonly listed: string[] = [];
  readonly fetched: FetchRequest[] = [];
  branches: string[] = ['main'];
  fetchError?: Error;
  async listBranches(repoPath: string): Promise<string[]> {
    this.listed.push(repoPath);
    return this.branches;
  }
  async fetchAll(req: FetchRequest): Promise<void> {
    this.fetched.push(req);
    if (this.fetchError) throw this.fetchError;
  }
}

export class RecordingBroadcaster implements SandboxEventBroadcaster {
  readonly events: SandboxWsEvent[] = [];
  broadcast(event: SandboxWsEvent): void {
    this.events.push(event);
  }
}

/** A credential facade with NO git credential — the public-repo path. */
export class NoGitCredentialFacade implements CredentialFacade {
  disposals = 0;
  /** When set, `prepareGitAuth` succeeds and hands back this env. */
  authEnv?: Record<string, string>;
  async prepareRuntimeCredential(): Promise<InjectableRuntimeCredential> {
    throw new CredentialPreparationError('NO_CREDENTIAL', 'not used');
  }
  async prepareForRefresh(): Promise<RefreshableRuntimeCredential> {
    throw new Error('not used');
  }
  async recordRuntimeInjection(): Promise<void> {}
  async prepareGitAuth(): Promise<GitAuthContext> {
    if (!this.authEnv) throw new CredentialPreparationError('NO_CREDENTIAL', 'no git credential');
    const env = this.authEnv;
    return {
      env,
      dispose: async () => {
        this.disposals += 1;
      },
    };
  }
}

export const fixedClock = (now: Date = NOW): Clock => ({ now: () => now });
export const noopEvents: EventBus = { publishInTx: () => {}, subscribe: () => {} };
export const directUow: UnitOfWork = { run: (fn) => fn({} as Tx) };

export function gitProject(id: string, opts: { branch?: string } = {}): Project {
  return Project.create({
    id: asProjectId(id),
    name: `project-${id}`,
    sourceType: 'git',
    repoUrl: 'https://example.com/org/repo.git',
    repoBranch: opts.branch,
    baselinePath: `/data/baselines/${id}`,
    now: NOW,
  });
}
