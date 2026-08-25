import { mkdir, writeFile, rm, chmod, cp, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { availableBytesFor } from '@platform/shared-kernel';
import { WorkspacePrepareError, DISK_INSUFFICIENT, classifyWorkspacePrepareError } from '@platform/contracts';
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

  /**
   * ⚠️ EVERY throw out of here is normalized to the closed set (`WorkspacePrepareError`).
   * Un-wrapped, what escapes is a Node fs error whose `.code` is an **errno** —
   * `ENOSPC`, `EACCES`, `ENOENT` — and `provisionSandbox`'s `failureOf` reads exactly
   * that field, so the errno became the sandbox's `failureCode` and went out on the
   * wire. The frontend keys its P22 §1 sentence off the code, has no entry for
   * `ENOSPC`, and falls back to generic copy — for the one failure with the clearest
   * possible user action ("free some disk").
   *
   * The wrap is at the METHOD boundary rather than per-call for the same reason the
   * clone path's guard is: five awaits here can each throw an errno, and a per-call
   * try/catch is five chances to forget — including in whatever line someone adds next.
   */
  async prepare(sandboxId: string, source: WorkspaceSource): Promise<PreparedWorkspace> {
    try {
      await this.ensureWorkspacesRoot();
      const hostPath = this.dir(sandboxId);
      await mkdir(hostPath, { recursive: true });
      await this.assertDiskSpace(source.baselinePath, hostPath);
      await writeFile(resolve(hostPath, STATE_FILE), 'preparing');
      await this.importBaseline(source.baselinePath, hostPath);
      await this.checkoutBranch(hostPath, source.branch);
      await writeFile(resolve(hostPath, STATE_FILE), 'ready');
      // writable by the non-root in-sandbox agent user; unreachable to other host
      // users thanks to the 0700 parent (see class doc).
      await chmod(hostPath, 0o777);
      return { hostPath };
    } catch (e) {
      throw classifyWorkspacePrepareError(e);
    }
  }

  /**
   * 磁盘预检 for the COPY side (03 §7.6). The clone path got one (03 §7.2★); this
   * path — which moves the SAME number of bytes, once per Task instead of once per
   * project — had none at all.
   *
   * ⚠️ WHY A FLOOR AND NOT 「基线体积」, WHEN THE BASELINE'S SIZE IS RIGHT THERE.
   * On the clone side the requirement was unknowable because nothing had asked the
   * remote how big the repo was. Here the opposite problem makes the same answer
   * correct: `cp -a --reflink=auto` on btrfs/XFS clones the baseline for ~ZERO bytes,
   * and there is no way to know in advance whether this filesystem will grant the
   * reflink — `--reflink=auto` silently degrades to a full byte copy on ext4. So the
   * requirement is either ≈0 or ≈baselineSize, and we cannot tell which. Demanding
   * `baselineSize` free would refuse Tasks that a CoW filesystem completes for free;
   * demanding nothing is what we had. A floor is the part that is true either way.
   *
   * What it catches is the case that actually happens on a single-machine deploy: a
   * disk already at the brim, where a Task copy is the thing that finishes it off.
   * Everything past the floor is still covered after the fact — `ENOSPC` now lands as
   * `DISK_INSUFFICIENT` via `classifyWorkspacePrepareError`, which before this change
   * reached the user as the literal string `ENOSPC`.
   */
  private async assertDiskSpace(baselinePath: string, hostPath: string): Promise<void> {
    const minFree = minFreeBytes();
    // measured on the WORKSPACE side: baseline and workspace can be different mounts
    // (`DATA_ROOT` on one disk, a bind-mounted baselines volume on another), and the
    // bytes are about to be written here.
    const available = await availableBytesFor(hostPath);
    if (available >= minFree) return;
    throw new WorkspacePrepareError(
      DISK_INSUFFICIENT,
      `not enough free space to prepare the workspace: ${String(available)} bytes ` +
        `available under ${hostPath}, ${String(minFree)} required ` +
        `(WORKSPACE_MIN_FREE_BYTES); baseline is ${baselinePath}`,
    );
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

/**
 * `WORKSPACE_MIN_FREE_BYTES` when it parses as a non-negative number, else the default.
 *
 * Deliberately a SEPARATE knob from the clone path's `CLONE_MIN_FREE_BYTES`: the two
 * checks guard different directories, which on a real deploy are routinely different
 * mounts, and an operator who tunes one has no reason to have meant the other.
 */
const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024; // 1 GiB, same floor as the clone side

function minFreeBytes(): number {
  const raw = process.env.WORKSPACE_MIN_FREE_BYTES;
  if (raw === undefined) return DEFAULT_MIN_FREE_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_FREE_BYTES;
}
