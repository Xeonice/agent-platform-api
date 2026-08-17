import { mkdir, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
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
