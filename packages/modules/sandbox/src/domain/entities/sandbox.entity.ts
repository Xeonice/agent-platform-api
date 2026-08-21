import { AggregateRoot } from '@platform/shared-kernel';
import type { SandboxId, ProjectId } from '@platform/shared-kernel';
import { SandboxStatusVO } from '../value-objects/sandbox-status.vo';
import type { SandboxStatus } from '../value-objects/sandbox-status.vo';
import type { StateTransition, TriggeredBy } from './state-transition.entity';
import { InvalidSandboxTransitionError } from '../errors/invalid-transition.error';
import { SandboxCreated, SandboxStateChanged } from '../events/sandbox-events';

export interface SandboxProps {
  id: SandboxId;
  projectId: ProjectId;
  runtime: string;
  provider: string;
  status: SandboxStatus;
  headless: boolean;
  /** null for interactive tasks; 30/60/120/240 for headless (13 §2.1). */
  timeoutMinutes: number | null;
  idleTimeoutSec: number;
  workspacePath: string | null;
  /** provider's opaque sandbox id (SandboxHandle.providerSandboxId); null until created. */
  providerSandboxId: string | null;
  /** provider runtime binding persisted for restart reconnect (boxlite agent port); null otherwise. */
  agentEndpointPort: number | null;
  /** per-sandbox bearer token for the in-sandbox agent; null for agent-less runtimes. */
  agentAuthToken: string | null;
  version: number;
  transitions: StateTransition[];
}

/**
 * Sandbox aggregate root (docs/backend/23 §5, 28 §2.2).
 * Holds the current status (a value object with the transition table) and an
 * append-only transition history persisted in the same aggregate.
 */
export class Sandbox extends AggregateRoot<SandboxId> {
  private _status: SandboxStatus;
  private _timeoutMinutes: number | null;
  private _idleTimeoutSec: number;
  private _workspacePath: string | null;
  private _providerSandboxId: string | null;
  private _agentEndpointPort: number | null;
  private _agentAuthToken: string | null;
  private _version: number;
  private readonly _transitions: StateTransition[];
  /** transitions appended in the current UoW, flushed by saveSync (28 §2.2). */
  private readonly _pendingTransitions: StateTransition[] = [];

  readonly projectId: ProjectId;
  readonly runtime: string;
  readonly provider: string;
  readonly headless: boolean;

  private constructor(props: SandboxProps) {
    super(props.id);
    this.projectId = props.projectId;
    this.runtime = props.runtime;
    this.provider = props.provider;
    this.headless = props.headless;
    this._status = props.status;
    this._timeoutMinutes = props.timeoutMinutes;
    this._idleTimeoutSec = props.idleTimeoutSec;
    this._workspacePath = props.workspacePath;
    this._providerSandboxId = props.providerSandboxId;
    this._agentEndpointPort = props.agentEndpointPort;
    this._agentAuthToken = props.agentAuthToken;
    this._version = props.version;
    this._transitions = props.transitions;
  }

  /** Rehydrate from persistence (repository.toDomain). No events raised. */
  static rehydrate(props: SandboxProps): Sandbox {
    return new Sandbox(props);
  }

  /** Create a brand-new sandbox in `pending` with its first transition. */
  static create(input: {
    id: SandboxId;
    projectId: ProjectId;
    runtime: string;
    provider: string;
    headless: boolean;
    timeoutMinutes: number | null;
    idleTimeoutSec: number;
    now: Date;
  }): Sandbox {
    const firstTransition: StateTransition = {
      from: null,
      to: 'pending',
      at: input.now,
      triggeredBy: 'user',
    };
    const sandbox = new Sandbox({
      id: input.id,
      projectId: input.projectId,
      runtime: input.runtime,
      provider: input.provider,
      status: 'pending',
      headless: input.headless,
      timeoutMinutes: input.timeoutMinutes,
      idleTimeoutSec: input.idleTimeoutSec,
      workspacePath: null,
      providerSandboxId: null,
      agentEndpointPort: null,
      agentAuthToken: null,
      version: 0,
      transitions: [firstTransition],
    });
    sandbox._pendingTransitions.push(firstTransition);
    sandbox.raise(new SandboxCreated(input.id, input.projectId, input.now));
    return sandbox;
  }

  get status(): SandboxStatus {
    return this._status;
  }
  get timeoutMinutes(): number | null {
    return this._timeoutMinutes;
  }
  get idleTimeoutSec(): number {
    return this._idleTimeoutSec;
  }
  get workspacePath(): string | null {
    return this._workspacePath;
  }
  get providerSandboxId(): string | null {
    return this._providerSandboxId;
  }
  get agentEndpointPort(): number | null {
    return this._agentEndpointPort;
  }
  /** SECRET — reachable only by the sandbox context; never mapped onto a wire DTO. */
  get agentAuthToken(): string | null {
    return this._agentAuthToken;
  }
  get version(): number {
    return this._version;
  }

  /** Record the provider handle + host workspace once created (03 §4). */
  bindRuntime(input: {
    providerSandboxId: string;
    workspacePath: string;
    agentEndpointPort?: number | null;
    agentAuthToken?: string | null;
  }): void {
    this._providerSandboxId = input.providerSandboxId;
    this._workspacePath = input.workspacePath;
    this._agentEndpointPort = input.agentEndpointPort ?? null;
    this._agentAuthToken = input.agentAuthToken ?? null;
  }
  get transitions(): readonly StateTransition[] {
    return this._transitions;
  }
  get pendingTransitions(): readonly StateTransition[] {
    return this._pendingTransitions;
  }

  /**
   * Assert the move is legal (I-SBX-1), append history, raise the state-changed
   * event. Illegal moves throw InvalidSandboxTransitionError (→ 409).
   */
  transitionTo(next: SandboxStatus, triggeredBy: TriggeredBy, now: Date): void {
    if (!SandboxStatusVO.canTransitionTo(this._status, next)) {
      throw new InvalidSandboxTransitionError(this._status, next);
    }
    const from = this._status;
    const transition: StateTransition = { from, to: next, at: now, triggeredBy };
    this._transitions.push(transition);
    this._pendingTransitions.push(transition);
    this._status = next;
    this.raise(new SandboxStateChanged(this.id, from, next, now));
  }

  /** called by repository after a successful flush (28 §2.2). */
  markPersisted(newVersion: number): void {
    this._version = newVersion;
    this._pendingTransitions.length = 0;
  }
}
