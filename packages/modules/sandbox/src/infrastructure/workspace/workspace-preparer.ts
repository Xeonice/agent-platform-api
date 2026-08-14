import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { PreparedWorkspace, WorkspacePreparer } from '@platform/contracts';

const STATE_FILE = '.platform-workspace-state';

/**
 * Filesystem WorkspacePreparer (03 §7.1/§7.6). Creates
 * `${DATA_ROOT}/workspaces/<sandboxId>` with a `.platform-workspace-state`
 * marker (preparing → ready). S1 skips the baseline copy (no project context yet)
 * but the directory it creates is really bind-mounted into the container.
 */
@Injectable()
export class FsWorkspacePreparer implements WorkspacePreparer {
  private dataRoot(): string {
    return process.env.DATA_ROOT ?? resolve(process.cwd(), 'data');
  }

  private dir(sandboxId: string): string {
    return resolve(this.dataRoot(), 'workspaces', sandboxId);
  }

  async prepare(sandboxId: string): Promise<PreparedWorkspace> {
    const hostPath = this.dir(sandboxId);
    await mkdir(hostPath, { recursive: true });
    await writeFile(resolve(hostPath, STATE_FILE), 'preparing');
    // S1: no baseline to cp -a --reflink; empty workspace.
    await writeFile(resolve(hostPath, STATE_FILE), 'ready');
    return { hostPath };
  }

  async cleanup(sandboxId: string, opts: { keep: boolean }): Promise<void> {
    const hostPath = this.dir(sandboxId);
    if (opts.keep) {
      await writeFile(resolve(hostPath, STATE_FILE), 'kept').catch(() => undefined);
      return;
    }
    await rm(hostPath, { recursive: true, force: true });
  }
}
