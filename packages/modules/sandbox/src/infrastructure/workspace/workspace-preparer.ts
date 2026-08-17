import { mkdir, writeFile, rm, chmod, cp, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { PreparedWorkspace, WorkspacePreparer, WorkspaceSource } from '@platform/contracts';

const STATE_FILE = '.platform-workspace-state';
const execFileAsync = promisify(execFile);

/**
 * Filesystem WorkspacePreparer (03 §7.1/§7.6). Creates
 * `${DATA_ROOT}/workspaces/<sandboxId>` and IMPORTS the project baseline into it
 * (S2): `cp -a --reflink=auto baseline/. workspace` — an empty project's baseline
 * is an empty dir, so the workspace ends up empty. The dir it creates is really
 * bind-mounted into the container as `/workspace`.
 *
 * The dir is made world-accessible (0777): the bind-mount appears ROOT-owned
 * inside the sandbox (neither docker nor BoxLite remaps host ownership), but the
 * in-sandbox AIO agent runs as the NON-root user `gem`, which otherwise cannot
 * traverse/write `/workspace`. Verified: 0755 ⇒ "Permission denied"; 0777 ⇒ r/w.
 */
@Injectable()
export class FsWorkspacePreparer implements WorkspacePreparer {
  private dataRoot(): string {
    return process.env.DATA_ROOT ?? resolve(process.cwd(), 'data');
  }

  private dir(sandboxId: string): string {
    return resolve(this.dataRoot(), 'workspaces', sandboxId);
  }

  async prepare(sandboxId: string, source: WorkspaceSource): Promise<PreparedWorkspace> {
    const hostPath = this.dir(sandboxId);
    await mkdir(hostPath, { recursive: true });
    await writeFile(resolve(hostPath, STATE_FILE), 'preparing');
    await this.importBaseline(source.baselinePath, hostPath);
    await writeFile(resolve(hostPath, STATE_FILE), 'ready');
    // make traversable/writable by the non-root in-sandbox agent user (see class doc).
    await chmod(hostPath, 0o777);
    return { hostPath };
  }

  /** Copy baseline contents into the workspace (CoW on Linux; portable fallback). */
  private async importBaseline(baselinePath: string, workspacePath: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(baselinePath);
    } catch {
      return; // baseline missing/unreadable ⇒ empty workspace
    }
    if (entries.length === 0) return; // empty project ⇒ nothing to copy
    if (process.platform === 'linux') {
      try {
        // reflink=auto ⇒ copy-on-write clone of a large repo baseline (03 §7.1).
        await execFileAsync('cp', ['-a', '--reflink=auto', `${baselinePath}/.`, workspacePath]);
        return;
      } catch {
        /* fall through to the portable copy */
      }
    }
    await cp(baselinePath, workspacePath, { recursive: true, force: true });
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
