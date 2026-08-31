import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { RetainedVolumeService } from './retained-volume.service';

/**
 * 扫描周期。保留期以**天**计（3/7/30），所以小时级的分辨率绰绰有余 —— 每分钟扫一遍
 * 只会让一个「到期后几小时内清掉」的需求变成 1440 倍的空转。
 */
const SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * `VolumeReaper`（03 §7.7 / 24 §5.1）：定时扫 `retainUntil <= now` → 删卷 → 置
 * `deletedAt`（**记录留档**，I-RV-2）。
 *
 * ⚠️ **`deletedAt` 非空即只读**，所以取数那一步就带上 `deleted_at IS NULL`
 * （`listExpired`）——否则每一轮都会把全部历史记录重新捞出来，对着早已不存在的目录
 * `rm -rf`、再对一条只读记录调 `markDeleted()`，I-RV-2 会把整轮打断。
 *
 * ⚠️ **单实例串行**：`running` 这把进程内的锁保证上一轮没跑完时下一轮不重入 —— 一个
 * 1.0 GB 的目录 `rm -rf` 不是瞬时操作，而两轮并发删同一个目录会让其中一轮以
 * `markDeleted()` 的 I-RV-2 冲突收场。
 */
@Injectable()
export class VolumeReaper implements OnApplicationBootstrap {
  private readonly logger = new Logger('VolumeReaper');
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly volumes: RetainedVolumeService) {}

  onApplicationBootstrap(): void {
    if (process.env.DISABLE_VOLUME_REAPER === '1') return;
    this.timer = setInterval(() => void this.runOnce(), SWEEP_INTERVAL_MS);
    // 不为了 reaper 把事件循环吊着（与 CredentialRefreshScanner 同款）
    this.timer.unref?.();
  }

  /** 一轮清理。幂等，可以直接被测试调用。 */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const reaped = await this.volumes.reapExpired();
      if (reaped > 0) this.logger.log(`reaped ${String(reaped)} expired retained volume(s)`);
      return reaped;
    } catch (e) {
      this.logger.warn(`volume sweep failed: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
