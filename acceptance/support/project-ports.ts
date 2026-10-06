import type { Clock, EventBus } from '@platform/shared-kernel';
import { CredentialPreparationError } from '@platform/contracts';
import type {
  CredentialFacade,
  SandboxEventBroadcaster,
  SandboxWsEvent,
} from '@platform/contracts';
import type { BaselineManager } from '../../packages/modules/project/src/domain/ports/baseline-manager.port';
import type {
  BaselineGit,
  FetchRequest,
} from '../../packages/modules/project/src/domain/ports/baseline-git.port';
import type {
  CloneRequest,
  GitCloner,
} from '../../packages/modules/project/src/domain/ports/git-cloner.port';

export const NOW = new Date('2026-10-05T00:00:00Z');
export const fixedClock = (at = NOW): Clock => ({ now: () => new Date(at.getTime()) });
export const noopEvents: EventBus = { publishInTx: () => {}, subscribe: () => {} };

/** External filesystem boundary; production repository and UoW are not replaced. */
export class FakeBaselineManager implements BaselineManager {
  readonly removed: string[] = [];
  async createEmptyDir() {}
  async removeDir(path: string) {
    this.removed.push(path);
  }
  async directorySizeBytes() {
    return 1024;
  }
  async availableBytes() {
    return 1024 ** 4;
  }
}
export class RecordingCloner implements GitCloner {
  readonly requests: CloneRequest[] = [];
  async clone(request: CloneRequest) {
    this.requests.push(request);
  }
}
export class RecordingBaselineGit implements BaselineGit {
  async listBranches() {
    return ['main'];
  }
  async fetchAll(_request: FetchRequest) {}
}
export class RecordingBroadcaster implements SandboxEventBroadcaster {
  readonly events: SandboxWsEvent[] = [];
  broadcast(event: SandboxWsEvent) {
    this.events.push(event);
  }
}
export const noGitCredentials: CredentialFacade = {
  prepareGitAuth: async () => {
    throw new CredentialPreparationError('NO_CREDENTIAL', 'public repository fixture');
  },
  prepareRuntimeCredential: async () => {
    throw new Error('runtime auth outside project scenario');
  },
  prepareForRefresh: async () => {
    throw new Error('refresh outside project scenario');
  },
  isRuntimeCredentialUsable: async () => {
    throw new Error('injection outside project scenario');
  },
  recordRuntimeInjection: async () => {
    throw new Error('injection outside project scenario');
  },
};
