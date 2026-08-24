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
    await this.checkoutBranch(hostPath, source.branch);
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

  /**
   * 建 Task 时选分支 (03 §7.2★): switch the FRESH COPY to the requested branch. Ordered
   * strictly after the baseline import and strictly before the instance is created,
   * exactly as 03 §7.6's pipeline says — there is no container yet, and nothing has
   * opened the workspace, so a checkout here is invisible to everything downstream.
   *
   * ⚠️ IT IS A PURELY LOCAL COMMAND, AND THAT IS THE ENTIRE POINT OF THE FULL CLONE.
   * The copy carries every remote-tracking ref, so `git checkout <name>` DWIMs into a
   * local branch tracking `origin/<name>` without contacting anything. Against a
   * `--depth=1 --single-branch` baseline the same command dies with
   * `pathspec '<name>' did not match any file(s) known to git` (measured), which is
   * why the shallow option is gone rather than configurable.
   *
   * ⚠️ THE TRAILING `--` IS NOT DECORATION AND IT MUST NOT MOVE. `git checkout X --`
   * means 「X is a REV, no pathspecs follow」; `git checkout -- X` means the opposite —
   * 「X is a PATH」 — i.e. "throw away local edits to the file named X". Written the
   * second way, a branch name that also names a tracked file would silently revert a
   * file instead of switching branch, and the workspace would start on the WRONG code
   * with no error at all. Without any `--`, git guesses, and refuses when the name is
   * ambiguous.
   *
   * `GIT_TERMINAL_PROMPT=0` because a local checkout has no business asking for
   * credentials — if some config ever made it try, it must fail rather than hang the
   * whole provision on a prompt nobody can answer.
   */
  private async checkoutBranch(workspacePath: string, branch?: string): Promise<void> {
    if (branch === undefined || branch === '') return;
    await execFileAsync('git', ['checkout', branch, '--'], {
      cwd: workspacePath,
      env: checkoutEnv(),
    });
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

/**
 * Env for the workspace checkout: ambient repo-location overrides REMOVED.
 *
 * ⚠️ `cwd` DOES NOT PIN WHICH REPOSITORY GIT ACTS ON. `GIT_DIR` / `GIT_WORK_TREE` /
 * `GIT_INDEX_FILE` and friends outrank it, so a platform process that inherited any of
 * them — launched from a git hook, or from a harness that sets them (vitest already
 * leaks `EDITOR` into children, which is how the clone path's guard list was found) —
 * would run this checkout against SOMEONE ELSE'S repository while reporting success.
 * The workspace would then start on the baseline's default branch with no error at all,
 * which is the silent-wrong-code failure this whole step exists to prevent.
 *
 * The clone path solves the same class of problem with a much longer list (03 §7.3,
 * `project/…/git-env.ts`); this is only the repo-location subset, because a local
 * checkout touches no credential, no transport and no remote.
 */
function checkoutEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_CEILING_DIRECTORIES',
  ]) {
    delete env[key];
  }
  return env;
}
