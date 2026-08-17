import { mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { PreparedWorkspace, WorkspacePreparer } from '@platform/contracts';

const STATE_FILE = '.platform-workspace-state';

/**
 * Filesystem WorkspacePreparer (03 §7.1/§7.6). Creates
 * `${DATA_ROOT}/workspaces/<sandboxId>` with a `.platform-workspace-state`
 * marker (preparing → ready). S1 skips the baseline copy (no project context yet)
 * but the directory it creates is really bind-mounted into the container.
 *
 * The dir is made world-accessible (0777): the bind-mount appears ROOT-owned
 * inside the sandbox (neither docker nor BoxLite remaps host ownership), but the
 * in-sandbox AIO agent runs as the NON-root user `gem`, which otherwise cannot
 * traverse/write `/workspace`. Verified: with 0755 the agent gets "Permission
 * denied"; with 0777 it reads and writes. Single-tenant private deploy, per-sandbox
 * dir — the broad mode is acceptable and required for S2/S3 (project code in-sandbox).
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
    // make traversable/writable by the non-root in-sandbox agent user (see class doc).
    await chmod(hostPath, 0o777);
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
