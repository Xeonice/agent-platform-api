import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { CLOCK, shiftMs } from '@platform/shared-kernel';
import type { Clock } from '@platform/shared-kernel';
import { AuditRepository } from './audit.repository';

/** 13 §2.8.2 双闸之一：按 `at` 保留 30 天。 */
export const RETENTION_DAYS = 30;
/** 13 §2.8.2 双闸之二：总量上限 20 万条（≈71.6 MB 含索引，实测）。 */
export const RETENTION_MAX_ROWS = 200_000;
/** 扫描间隔。裁剪本身是分片的，扫描频率只决定「超额多久被收走」。 */
export const RETENTION_SWEEP_MS = 60 * 60 * 1000;

/**
 * 审计保留作业 —— **双闸**（13 §2.8.2）。
 *
 * ⚠️ **两个闸都要有**：只按时间，一次异常风暴就能把库撑爆；只按条数，低频部署会丢掉
 * 本该留住的历史。
 *
 * ⚠️ **原先文档并列写的「200 MB」体积闸已被删除**（13 §2.8.2 实测收口）：20 万条只有
 * 71.6 MB，200 MB 约合 55 万条 —— 两者不是同一个量级，并列会让人以为哪个先到都行。
 * 这里只实现条数闸，与文档现状一致。
 *
 * ⛔ **裁剪分片、批间让出事件循环**，硬纪律在 `AuditRepository.pruneBatch` 上。
 */
@Injectable()
export class AuditRetentionJob implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('AuditRetention');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly repo: AuditRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap(): void {
    // ⚠️ `unref()`：这只定时器不该让进程活着。少了它，每个 boot 整个 AppModule 的
    // e2e 都会挂住一个小时不退出 —— 而"测试跑完不退"看起来跟"测试卡死"一模一样。
    this.timer = setInterval(() => void this.sweep(), RETENTION_SWEEP_MS);
    this.timer.unref();
    // 开机也扫一次：进程可能停了很久，30 天的闸不该等下一个整点才生效。
    void this.sweep();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * 跑一轮双闸。**可重入保护**：上一轮还没跑完（大批量首扫可能跨越多个 tick）时
   * 直接跳过，两轮并行只会互相抢同一批 victim 然后各删一半。
   */
  async sweep(): Promise<{ byAge: number; byCount: number } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const cutoff = shiftMs(this.clock.now(), -RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const byAge = await this.repo.pruneOlderThan(cutoff);
      const byCount = await this.repo.pruneToMaxRows(RETENTION_MAX_ROWS);
      if (byAge + byCount > 0) {
        this.logger.log(
          `audit retention: pruned ${String(byAge)} by age (>${String(RETENTION_DAYS)}d) ` +
            `and ${String(byCount)} by row cap (>${String(RETENTION_MAX_ROWS)})`,
        );
      }
      return { byAge, byCount };
    } catch (e) {
      // 与写入口同一条处置：保留作业炸了不该拖垮进程，但必须有人看得见。
      this.logger.error(`audit retention sweep failed: ${(e as Error).message}`);
      return null;
    } finally {
      this.running = false;
    }
  }
}
