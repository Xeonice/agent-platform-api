import { asAutomationId, asProjectId } from '@platform/shared-kernel';
import type {
  AutomationId,
  Clock,
  EventBus,
  IdGenerator,
  ProjectId,
  Tx,
  UnitOfWork,
} from '@platform/shared-kernel';
import type { DomainEvent } from '@platform/shared-kernel';
import type {
  AuditRecorder,
  AutomationTaskLaunchInput,
  AutomationTaskLauncher,
  AutomationTaskPhase,
  CredentialStatus,
  RuntimeCredentialStateReader,
} from '@platform/contracts';
import { Automation } from '../../src/domain/entities/automation.entity';
import { AutomationRun } from '../../src/domain/entities/automation-run.entity';
import type { AutomationRepository } from '../../src/domain/repositories/automation.repository';
import type {
  AutomationRunRepository,
  RunPage,
  RunSlice,
} from '../../src/domain/repositories/automation-run.repository';

/**
 * 调度器单测用的**内存替身**（25 L0：application 层的密封测试）。
 *
 * ⚠️ 它们是替身不是 mock 框架：每一个都是可以断言其**内容**的普通对象。调度器要证明
 * 的东西（先推进后执行、mutex、missed 阈值、重试上限、只读规则自己的时区）全都表现为
 * 「库里最后是什么」与「调用顺序是什么」，用真对象比用 spy 更能钉住。
 */
export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(d: Date): void {
    this.current = d;
  }
  advanceMinutes(n: number): void {
    this.current = new Date(this.current.getTime() + n * 60_000);
  }
}

export class SeqIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `id-${String(this.n)}`;
  }
}

const FAKE_TX = {} as Tx;

export class SyncUow implements UnitOfWork {
  run<T>(fn: (tx: Tx) => T): T {
    return fn(FAKE_TX);
  }
}

export class RecordingEventBus implements EventBus {
  readonly published: DomainEvent[] = [];
  publishInTx(_tx: Tx, events: DomainEvent[]): void {
    this.published.push(...events);
  }
  subscribe(): void {
    /* not used in these tests */
  }
}

export class NoopAudit implements AuditRecorder {
  readonly records: unknown[] = [];
  record(entry: unknown): void {
    this.records.push(entry);
  }
}

export class InMemoryAutomationRepo implements AutomationRepository {
  readonly rows = new Map<string, Automation>();
  /** 每次 `saveSync` 时的 `nextTriggerAt` 快照 —— 「先推进后执行」的证据链。 */
  readonly saveLog: { id: string; nextTriggerAt: string | null }[] = [];

  seed(a: Automation): Automation {
    this.rows.set(a.id, a);
    return a;
  }
  findById(id: AutomationId): Promise<Automation | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  listByProject(projectId: ProjectId): Promise<Automation[]> {
    return Promise.resolve([...this.rows.values()].filter((a) => a.projectId === projectId));
  }
  countByProject(projectId: ProjectId): Promise<number> {
    return Promise.resolve([...this.rows.values()].filter((a) => a.projectId === projectId).length);
  }
  listDue(now: Date): Promise<Automation[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (a) => a.enabled && a.nextTriggerAt !== null && a.nextTriggerAt.getTime() <= now.getTime(),
      ),
    );
  }
  listAllForSweep(): Promise<Automation[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  saveSync(_tx: Tx, a: Automation): void {
    this.rows.set(a.id, a);
    this.saveLog.push({ id: a.id, nextTriggerAt: a.nextTriggerAt?.toISOString() ?? null });
  }
  deleteSync(_tx: Tx, id: AutomationId): void {
    this.rows.delete(id);
  }
}

export class InMemoryRunRepo implements AutomationRunRepository {
  readonly rows = new Map<string, AutomationRun>();

  seed(r: AutomationRun): AutomationRun {
    this.rows.set(r.id, r);
    return r;
  }
  findById(id: string): Promise<AutomationRun | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  findLatest(automationId: AutomationId): Promise<AutomationRun | null> {
    const mine = [...this.rows.values()]
      .filter((r) => r.automationId === automationId)
      .sort((a, b) => b.triggeredAt.getTime() - a.triggeredAt.getTime() || (a.id < b.id ? 1 : -1));
    return Promise.resolve(mine[0] ?? null);
  }
  listByAutomation(automationId: AutomationId, page: RunPage): Promise<RunSlice> {
    const mine = [...this.rows.values()].filter((r) => r.automationId === automationId);
    const start = (page.page - 1) * page.pageSize;
    return Promise.resolve({ items: mine.slice(start, start + page.pageSize), total: mine.length });
  }
  listPendingRetries(now: Date): Promise<AutomationRun[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (r) =>
          r.status === 'resource-exhausted' &&
          r.retryAt !== null &&
          r.retryAt.getTime() <= now.getTime(),
      ),
    );
  }
  listActive(): Promise<AutomationRun[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.status === 'pending' || r.status === 'running'),
    );
  }
  listOutcomePending(limit: number): Promise<AutomationRun[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => !r.outcomeApplied && ['success', 'failed', 'timeout'].includes(r.status))
        .slice(0, limit),
    );
  }
  saveSync(_tx: Tx, run: AutomationRun): void {
    this.rows.set(run.id, run);
  }
}

/**
 * 可编排的 Task 出口替身。
 *
 * `script` 决定 `createSandbox` 的行为；`phases` 决定 `phaseOf` 每次回什么。
 */
export class FakeLauncher implements AutomationTaskLauncher {
  readonly created: AutomationTaskLaunchInput[] = [];
  readonly started: string[] = [];
  /** 依次消费；用完之后恒定回最后一个。 */
  phaseQueue: AutomationTaskPhase[] = [{ kind: 'provisioning' }];
  createBehaviour: () => { sandboxId: string } = () => ({ sandboxId: 'sbx-1' });

  createSandbox(input: AutomationTaskLaunchInput): Promise<{ sandboxId: string }> {
    this.created.push(input);
    return Promise.resolve(this.createBehaviour());
  }
  startTask(sandboxId: string): Promise<void> {
    this.started.push(sandboxId);
    return Promise.resolve();
  }
  phaseOf(): Promise<AutomationTaskPhase> {
    const next = this.phaseQueue.length > 1 ? this.phaseQueue.shift() : this.phaseQueue[0];
    return Promise.resolve(next ?? { kind: 'gone' });
  }
}

export class FakeCredentials implements RuntimeCredentialStateReader {
  constructor(public state: CredentialStatus = 'active') {}
  stateOf(): Promise<CredentialStatus> {
    return Promise.resolve(this.state);
  }
}

/** 一条每小时整点跑的规则，创建于 `createdAt`。 */
export function hourlyRule(id: string, createdAt: Date, timezone = 'UTC'): Automation {
  return Automation.create({
    id: asAutomationId(id),
    projectId: asProjectId('prj-1'),
    name: `rule-${id}`,
    runtimeId: 'codex',
    prompt: 'go',
    scheduleKind: 'hourly',
    scheduleConfig: { minute: 0 },
    timezone,
    timeoutMinutes: 120,
    artifactRetentionDays: 7,
    now: createdAt,
  });
}
