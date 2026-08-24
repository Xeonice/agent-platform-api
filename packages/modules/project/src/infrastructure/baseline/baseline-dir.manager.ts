import { mkdir, rm, readdir, stat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { BaselineManager } from '../../domain/ports/baseline-manager.port';

/**
 * Filesystem BaselineManager (docs/backend/03 §7.1). Manages the
 * `DATA_ROOT/baselines/<projectId>` directory. The baseline→workspace copy is the
 * sandbox context's job (FsWorkspacePreparer); this only owns the baseline dir.
 */
@Injectable()
export class FsBaselineDirManager implements BaselineManager {
  async createEmptyDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async removeDir(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  /**
   * Free bytes on the filesystem that will hold `path` (03 §7.2★ 磁盘预检).
   *
   * ⚠️ IT WALKS UP TO THE DEEPEST EXISTING ANCESTOR ON PURPOSE. The whole point of the
   * check is to run BEFORE anything is written, so on a fresh install neither
   * `DATA_ROOT/baselines/<id>` nor `DATA_ROOT/baselines` exists yet and `statfs` on
   * either would be ENOENT. An ancestor is on the SAME filesystem in every case that
   * matters here (the missing components are ones we are about to `mkdir`), so the
   * answer is the same number, just obtainable.
   *
   * `bavail` (blocks available to a NON-privileged process), not `bfree` — on ext4 the
   * two differ by the ~5% root reserve, and reporting space the platform cannot
   * actually use is precisely the mistake this check exists to stop.
   */
  async availableBytes(path: string): Promise<number> {
    let probe = resolve(path);
    for (;;) {
      try {
        const fs = await statfs(probe);
        return Number(fs.bavail) * Number(fs.bsize);
      } catch {
        const parent = dirname(probe);
        // `dirname('/') === '/'` — the loop's only exit when nothing is statable.
        // `Infinity` = "unknown, do not block": a pre-check that cannot measure must
        // not refuse a clone that would have succeeded. The post-hoc ENOSPC classifier
        // (`error.classifier.ts`) is still there for the real out-of-space case.
        if (parent === probe) return Number.POSITIVE_INFINITY;
        probe = parent;
      }
    }
  }

  async directorySizeBytes(path: string): Promise<number> {
    let total = 0;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return 0; // missing dir ⇒ 0
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        total += await this.directorySizeBytes(full);
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size;
        } catch {
          /* raced deletion — ignore */
        }
      }
    }
    return total;
  }
}
