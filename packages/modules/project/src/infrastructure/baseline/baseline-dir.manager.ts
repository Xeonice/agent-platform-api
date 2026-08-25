import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { availableBytesFor } from '@platform/shared-kernel';
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
  /**
   * Delegates to shared-kernel: the SAME arithmetic backs the workspace-copy
   * pre-check in the sandbox module (03 §7.6), and the two contexts cannot import
   * each other. See `availableBytesFor` for why it is `bavail` and why the
   * ancestor walk is the ordinary path rather than a fallback.
   */
  async availableBytes(path: string): Promise<number> {
    return availableBytesFor(path);
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
