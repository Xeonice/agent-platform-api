import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CLOCK,
  EVENT_BUS,
  ID_GENERATOR,
  UNIT_OF_WORK,
  asProjectId,
  asRetainedVolumeId,
} from '@platform/shared-kernel';
import type { Clock, EventBus, IdGenerator, UnitOfWork } from '@platform/shared-kernel';
import { AUDIT_RECORDER } from '@platform/contracts';
import type {
  AuditRecorder,
  RegisterRetainedVolumeCommand,
  RetainedVolumeDto,
  RetentionDays,
} from '@platform/contracts';
import { RetainedVolume } from '../domain/entities/retained-volume.entity';
import { RETAINED_VOLUME_REPOSITORY } from '../domain/repositories/retained-volume.repository';
import type { RetainedVolumeRepository } from '../domain/repositories/retained-volume.repository';
import { RETAINED_VOLUME_STORE } from '../domain/ports/retained-volume-store.port';
import type {
  RetainedVolumeArchive,
  RetainedVolumeStore,
} from '../domain/ports/retained-volume-store.port';

/** 默认保留期（P20 §6）。自动化产物由调用方传规则的 `artifactRetentionDays`。 */
export const DEFAULT_RETENTION_DAYS: RetentionDays = 30;

/**
 * 「已保留卷」这条切片的 application 层（03 §7.7 / 24 §5 / 23 §6.2）。
 *
 * ⚠️ **它补的是一个「看起来做了、实际没有」的洞**：本轮之前 `destroy(keepVolume:true)`
 * 只往目录里写了一个 `kept` 标记文件，`retained_volumes` 一条记录都不登记 —— 端点接上
 * 也只会永远返回空数组（10 §6 那一格的原话）。
 */
@Injectable()
export class RetainedVolumeService {
  private readonly logger = new Logger('RetainedVolumeService');

  constructor(
    @Inject(RETAINED_VOLUME_REPOSITORY) private readonly repo: RetainedVolumeRepository,
    @Inject(RETAINED_VOLUME_STORE) private readonly store: RetainedVolumeStore,
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  /**
   * `RegisterRetainedVolumeCommand`（24 §3 时序图上 `APP → PRJ` 的那一步）。
   *
   * **幂等**：同一个 `workspacePath` 再登记一次是 no-op（I-RV-3 的应用层那一半）。
   * 24 §5.2 说得很清楚：登记（PRJ 侧）与 sandbox 终态（SBX 侧）是两个聚合两个事务，
   * 中间崩溃后重放会再走一次这里，那时唯一约束保证的是「不重复登记」，而不是「炸一次」。
   */
  async register(command: RegisterRetainedVolumeCommand): Promise<void> {
    const existing = await this.repo.findByWorkspacePath(command.workspacePath);
    if (existing) return; // I-RV-3：已登记 ⇒ no-op（重放路径）

    if (!(await this.store.exists(command.workspacePath))) {
      // 目录不在就没有什么可登记的。目录是事实、表是索引（03 §7.7），凭空登记一条
      // 指向不存在目录的记录，只会让「已保留卷」列出一个点开就 404 的条目。
      this.logger.warn(
        `not registering a retained volume for ${command.workspacePath}: directory is gone`,
      );
      return;
    }

    const { diskBytes, downloadBytes } = await this.store.measure(command.workspacePath);
    const now = this.clock.now();
    const volume = RetainedVolume.register({
      id: asRetainedVolumeId(this.ids.next()),
      projectId: asProjectId(command.projectId),
      sandboxId: command.sandboxId,
      workspacePath: command.workspacePath,
      source: command.source,
      retentionDays: command.retentionDays ?? DEFAULT_RETENTION_DAYS,
      diskBytes,
      downloadBytes,
      now,
    });
    // `VolumeRetained` 是**业务事实**，走入口 ①（Outbox → AuditProjector，23 §6.4），
    // 与项目那几条同源；下面两处删除走入口 ②（应用层直记），因为 reaper 那一路
    // 压根没有聚合在 publish。
    this.uow.run((tx) => {
      this.repo.saveSync(tx, volume);
      this.events.publishInTx(tx, volume.pullEvents());
    });
  }

  /** `GET /api/retained-volumes?projectId=` —— **不含已清理的**（I-RV-2 只读留档）。 */
  async list(projectId?: string): Promise<RetainedVolumeDto[]> {
    const volumes =
      projectId === undefined
        ? await this.repo.listAll()
        : await this.repo.listByProject(asProjectId(projectId));
    return volumes.map(toDto);
  }

  /**
   * `DELETE /api/retained-volumes/:id` —— 手动清理。**先删目录，再置 `deletedAt`。**
   *
   * ⚠️ 顺序不能反：先置 `deletedAt` 再删目录，中间崩溃就留下一条「已清理」的记录 +
   * 一个谁也管不到的目录（reaper 只捞 `deleted_at IS NULL`，它再也扫不到）。反过来则
   * 最坏是一条到期后被 reaper 重新处理一遍的记录 —— `rm -rf` 幂等，重放无害。
   */
  async remove(id: string): Promise<void> {
    const volume = await this.repo.findById(asRetainedVolumeId(id));
    // 已清理的记录只留档、对外不可见（I-RV-2）⇒ 与不存在同义
    if (!volume || volume.isDeleted) throw new NotFoundException(`retained volume ${id} not found`);
    await this.store.remove(volume.workspacePath);
    const now = this.clock.now();
    volume.markDeleted(now);
    this.uow.run((tx) => {
      this.repo.saveSync(tx, volume);
    });
    this.audit.record({
      category: 'project',
      type: 'project.volume_deleted',
      actor: 'user',
      subjectType: 'retained_volume',
      subjectId: volume.id,
      summary: `清理了保留卷（回收约 ${String(volume.diskBytes ?? 0)} 字节）`,
      detail: { projectId: volume.projectId, diskBytes: volume.diskBytes },
      outcome: 'ok',
    });
  }

  /**
   * `GET /api/retained-volumes/:id/archive` —— **tar 流 + 精确 `Content-Length`**。
   *
   * ⛔ 不压缩：gzip 后的大小只有真压完才知道，而响应头必须先发 ⇒ 边压边传就给不出
   * `Content-Length` ⇒ 浏览器进度条显示「未知大小」。口径全文见 10 §6。
   */
  async openArchive(id: string): Promise<RetainedVolumeArchive & { filename: string }> {
    const volume = await this.repo.findById(asRetainedVolumeId(id));
    // I-RV-2：已清理的不可下载 —— 目录早就没了，能给的只有一个 20 字节的空 tar
    if (!volume || volume.isDeleted) throw new NotFoundException(`retained volume ${id} not found`);
    if (!(await this.store.exists(volume.workspacePath))) {
      throw new NotFoundException(`retained volume ${id} is no longer on disk`);
    }
    const archive = await this.store.openArchive(volume.workspacePath);
    return { ...archive, filename: `${volume.sandboxId ?? volume.id}.tar` };
  }

  /**
   * `VolumeReaper` 的一轮（24 §5.1）：到期 → 删卷 → 置 `deletedAt`（记录留档）。
   * 返回这一轮真正清掉的条数，供调用方记日志/测试断言。
   */
  async reapExpired(): Promise<number> {
    const now = this.clock.now();
    const expired = await this.repo.listExpired(now);
    let reaped = 0;
    for (const volume of expired) {
      try {
        await this.store.remove(volume.workspacePath);
        volume.markDeleted(this.clock.now());
        this.uow.run((tx) => {
          this.repo.saveSync(tx, volume);
        });
        reaped += 1;
        this.audit.record({
          category: 'project',
          type: 'project.volume_deleted',
          actor: 'reaper',
          subjectType: 'retained_volume',
          subjectId: volume.id,
          summary: `保留期到期，已清理保留卷（回收约 ${String(volume.diskBytes ?? 0)} 字节）`,
          detail: {
            projectId: volume.projectId,
            retainUntil: volume.retainUntil.toISOString(),
            diskBytes: volume.diskBytes,
          },
          outcome: 'ok',
        });
      } catch (e) {
        // 一条清不掉不该带走整批：下一轮还会扫到它（deleted_at 仍是 NULL）。
        this.logger.warn(`failed to reap retained volume ${volume.id}: ${(e as Error).message}`);
      }
    }
    return reaped;
  }
}

function toDto(volume: RetainedVolume): RetainedVolumeDto {
  return {
    id: volume.id,
    projectId: volume.projectId,
    ...(volume.sandboxId !== null ? { sandboxId: volume.sandboxId } : {}),
    source: volume.source,
    retainedAt: volume.retainedAt.toISOString(),
    retainUntil: volume.retainUntil.toISOString(),
    // 库里可空（历史行/量不到），对外给 0 而不是缺字段：前端要的是一个能渲染的数字，
    // 而 `undefined` 在两个大小并排显示的位置上只会变成一个空格。
    diskBytes: volume.diskBytes ?? 0,
    downloadBytes: volume.downloadBytes ?? 0,
  };
}
