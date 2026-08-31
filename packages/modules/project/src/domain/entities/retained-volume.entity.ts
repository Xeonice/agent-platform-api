import { AggregateRoot, fromEpochMs, shiftMs } from '@platform/shared-kernel';
import type { ProjectId, RetainedVolumeId } from '@platform/shared-kernel';
import { RetainedVolumeStateError } from '../errors/project-errors';
import { VolumeRetained } from '../events/project-events';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ⚠️ 这两个类型在 domain 里**重新声明**，不从 `@platform/contracts` import —— domain
 * 层按 01 §3 的分层规则不许依赖 contracts（eslint `boundaries/element-types` 会拦）。
 * 与 `project.entity.ts` 里 `ProjectSourceType` / `CloneErrorCode` 的做法一致：契约那
 * 一份是**线上形状**，这一份是**领域词汇**，两者恰好同名同值不代表它们是同一个概念。
 * 取值口径见 13 §2.2.2 的 CHECK 与 I-RV-1。
 */
export type RetainedVolumeSource = 'manual-destroy' | 'automation-artifact';
export type RetentionDays = 3 | 7 | 30;

const ALLOWED_RETENTION_DAYS: readonly number[] = [3, 7, 30];

export interface RetainedVolumeProps {
  id: RetainedVolumeId;
  projectId: ProjectId;
  sandboxId: string | null;
  workspacePath: string;
  source: RetainedVolumeSource;
  diskBytes: number | null;
  downloadBytes: number | null;
  retainedAt: Date;
  retainUntil: Date;
  deletedAt: Date | null;
}

/**
 * `RetainedVolume` —— **独立聚合**（23 §6.2 裁决 D-4）。
 *
 * 为什么不是 `Sandbox` 的一部分：① 生命周期独立，sandbox 记录 90 天归档之后卷还在，
 * 产品明确「项目删除不级联删保留卷」；② 它有自己的不变量（保留期）；③「已保留卷」
 * 列表按它自己的 ID 直接管理（P21-6 §3.3）。
 *
 * | 编号 | 不变量 |
 * |---|---|
 * | **I-RV-1** | `retainUntil > retainedAt`；保留期 ∈ {3, 7, 30} 天 |
 * | **I-RV-2** | `deletedAt` 非空 ⇒ 记录**只读**（已清理，留档审计） |
 * | **I-RV-3** | `workspacePath` 全局唯一 —— 同一个宿主目录不能被登记两次 |
 *
 * I-RV-3 是**双保险**（23 §4.6 第三类）：DB 上一个 UNIQUE，应用层再拦一次；只有 DB
 * 那一道能挡住两个并发的销毁，只有应用层那一道能把它变成一次「已登记 ⇒ no-op」而不是
 * 一个把 destroy 打断的异常（24 §5.2）。
 */
export class RetainedVolume extends AggregateRoot<RetainedVolumeId> {
  readonly projectId: ProjectId;
  private _sandboxId: string | null;
  readonly workspacePath: string;
  readonly source: RetainedVolumeSource;
  private _diskBytes: number | null;
  private _downloadBytes: number | null;
  readonly retainedAt: Date;
  readonly retainUntil: Date;
  private _deletedAt: Date | null;

  private constructor(props: RetainedVolumeProps) {
    super(props.id);
    this.projectId = props.projectId;
    this._sandboxId = props.sandboxId;
    this.workspacePath = props.workspacePath;
    this.source = props.source;
    this._diskBytes = props.diskBytes;
    this._downloadBytes = props.downloadBytes;
    this.retainedAt = props.retainedAt;
    this.retainUntil = props.retainUntil;
    this._deletedAt = props.deletedAt;
  }

  static rehydrate(props: RetainedVolumeProps): RetainedVolume {
    return new RetainedVolume(props);
  }

  /**
   * 登记一个保留下来的卷。**I-RV-1 在这里成立或根本不成立** —— 保留期只有 3/7/30 三个
   * 取值，别的天数是调用方算错了，不是一个可以四舍五入的输入。
   */
  static register(input: {
    id: RetainedVolumeId;
    projectId: ProjectId;
    sandboxId?: string;
    workspacePath: string;
    source: RetainedVolumeSource;
    retentionDays: RetentionDays;
    diskBytes: number;
    downloadBytes: number;
    now: Date;
  }): RetainedVolume {
    if (!ALLOWED_RETENTION_DAYS.includes(input.retentionDays)) {
      throw new RetainedVolumeStateError(
        `retention period must be one of ${ALLOWED_RETENTION_DAYS.join('/')} days (I-RV-1), got ${String(input.retentionDays)}`,
      );
    }
    if (input.workspacePath.trim() === '') {
      throw new RetainedVolumeStateError('workspacePath is required (I-RV-3 keys on it)');
    }
    // `new Date(...)` 在本仓被禁（01 §3：时间只能来自 Clock 端口），所以走
    // shared-kernel 的两个受控帮手：先复制一份 `now`（`shiftMs` 是**原地改**的，
    // 直接传 `input.now` 会把调用方那个 Date 一起挪走），再位移。
    const retainUntil = shiftMs(fromEpochMs(input.now.getTime()), input.retentionDays * DAY_MS);
    // I-RV-1 的另一半。retentionDays 已被上面收进正数闭集，这条断言因此只会在
    // 「有人绕过闭集」时出声 —— 留着是因为不变量的成立不该依赖上一行的措辞。
    if (retainUntil.getTime() <= input.now.getTime()) {
      throw new RetainedVolumeStateError('retainUntil must be strictly after retainedAt (I-RV-1)');
    }
    const volume = new RetainedVolume({
      id: input.id,
      projectId: input.projectId,
      sandboxId: input.sandboxId ?? null,
      workspacePath: input.workspacePath,
      source: input.source,
      diskBytes: input.diskBytes,
      downloadBytes: input.downloadBytes,
      retainedAt: input.now,
      retainUntil,
      deletedAt: null,
    });
    volume.raise(
      new VolumeRetained(
        input.id,
        input.projectId,
        input.sandboxId ?? null,
        retainUntil,
        input.diskBytes,
        input.downloadBytes,
        input.now,
      ),
    );
    return volume;
  }

  get sandboxId(): string | null {
    return this._sandboxId;
  }

  get diskBytes(): number | null {
    return this._diskBytes;
  }

  get downloadBytes(): number | null {
    return this._downloadBytes;
  }

  get deletedAt(): Date | null {
    return this._deletedAt;
  }

  /** I-RV-2：清理过的记录只留档，任何写入都不再合法。 */
  get isDeleted(): boolean {
    return this._deletedAt !== null;
  }

  isExpiredAt(now: Date): boolean {
    return !this.isDeleted && this.retainUntil.getTime() <= now.getTime();
  }

  /**
   * 目录已经被 `rm -rf` 之后置 `deletedAt`。**记录不删**（留档审计，13 §2.2.2）。
   *
   * ⚠️ 第二次调用抛错而不是静默通过：一条已清理的记录被再次「清理」，说明调用方以为
   * 自己刚删掉了某个目录 —— 那个目录其实早没了，而它下一步会据此去报告一个不存在的
   * 回收量。I-RV-2 的全部意义就是让这种误会出声。
   */
  markDeleted(now: Date): void {
    this.assertMutable('delete');
    this._deletedAt = now;
  }

  /** sandbox 记录归档后置空（弱引用，13 §2.2.2）。 */
  detachSandbox(): void {
    this.assertMutable('detach the source sandbox from');
    this._sandboxId = null;
  }

  private assertMutable(action: string): void {
    if (this.isDeleted) {
      throw new RetainedVolumeStateError(
        `cannot ${action} retained volume ${this.id}: it was already cleaned up at ` +
          `${(this._deletedAt as Date).toISOString()} and is read-only (I-RV-2)`,
      );
    }
  }
}
