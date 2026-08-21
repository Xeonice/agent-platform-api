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
 * ── Permissions (03 §7.6) ───────────────────────────────────────────────────
 * Each workspace dir itself stays 0777. That is not a preference: the bind-mount
 * appears ROOT-owned inside the sandbox (neither docker nor BoxLite remaps host
 * ownership) while the in-sandbox agent runs as the NON-root user `gem`, so
 * anything tighter breaks it (measured: 0755 ⇒ "Permission denied"; 0777 ⇒ r/w).
 * `chown` to that user is not available here either — it needs root/CAP_CHOWN the
 * platform process usually lacks, and the uid is not even KNOWABLE at this point
 * in the pipeline: `preparing-workspace` runs BEFORE `creating`, so there is no
 * instance yet to probe (03 §7.6 rightly forbids hard-coding 1000).
 *
 * What DOES close the hole is the PARENT: `${DATA_ROOT}/workspaces` is created
 * 0700 and owned by the platform user, so no other local user can traverse into
 * it — and a 0777 dir you cannot reach is not an access surface. (Verified on
 * Linux: with the parent 0700 another uid gets EACCES on read AND on creating a
 * file inside the 0777 child; flip the parent to 0755 and both succeed. The
 * bind-mount is unaffected — the daemon resolves the source as root.)
 *
 * Residual, stated honestly: this stops OTHER local users, not other processes
 * running AS THE PLATFORM USER — those already have the DB and the Vault key.
 */
@Injectable()
export class FsWorkspacePreparer implements WorkspacePreparer {
  private dataRoot(): string {
    return process.env.DATA_ROOT ?? resolve(process.cwd(), 'data');
  }

  private workspacesRoot(): string {
    return resolve(this.dataRoot(), 'workspaces');
  }

  private dir(sandboxId: string): string {
    return resolve(this.workspacesRoot(), sandboxId);
  }

  /**
   * The single gate protecting every workspace: 0700 on the shared parent. Applied
   * on every prepare (not just the first) so a root that predates this hardening —
   * or one a deploy script recreated 0755 — is tightened before anything is copied
   * into it.
   */
  private async ensureWorkspacesRoot(): Promise<string> {
    const root = this.workspacesRoot();
    await mkdir(root, { recursive: true });
    await chmod(root, 0o700);
    return root;
  }

  async prepare(sandboxId: string, source: WorkspaceSource): Promise<PreparedWorkspace> {
    await this.ensureWorkspacesRoot();
    const hostPath = this.dir(sandboxId);
    await mkdir(hostPath, { recursive: true });
    await writeFile(resolve(hostPath, STATE_FILE), 'preparing');
    await this.importBaseline(source.baselinePath, hostPath);
    await writeFile(resolve(hostPath, STATE_FILE), 'ready');
    // writable by the non-root in-sandbox agent user; unreachable to other host
    // users thanks to the 0700 parent (see class doc).
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
