import { mkdtempSync, rmSync, mkdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsWorkspacePreparer } from '../../src/infrastructure/workspace/workspace-preparer';

/**
 * Workspace permissions (03 §7.6, 加固 2).
 *
 * The workspace dir itself has to stay 0777 — the bind-mount shows up root-owned
 * inside the sandbox while the agent runs as a non-root user, and `chown` is not
 * available to the platform at this point in the pipeline (no instance exists yet
 * to probe a uid from, and the process usually lacks CAP_CHOWN). So the guard is
 * the PARENT: `${DATA_ROOT}/workspaces` at 0700 means no other local user can
 * traverse in, which makes the 0777 child unreachable rather than merely wide.
 *
 * Both halves are asserted because either one alone is wrong: drop the 0700 and
 * every local user can read the cloned private repo AND drop an `AGENTS.md` in the
 * agent's path; tighten the 0777 and the sandbox cannot write its own workspace.
 */
const mode = (p: string): number => statSync(p).mode & 0o777;

let dataRoot: string;
let prevDataRoot: string | undefined;

beforeEach(() => {
  prevDataRoot = process.env.DATA_ROOT;
  dataRoot = mkdtempSync(resolve(tmpdir(), 'ws-perm-'));
  process.env.DATA_ROOT = dataRoot;
});

afterEach(() => {
  if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
  else process.env.DATA_ROOT = prevDataRoot;
  rmSync(dataRoot, { recursive: true, force: true });
});

describe('FsWorkspacePreparer permissions', () => {
  it('locks the shared workspaces root to 0700 and leaves the workspace 0777', async () => {
    const baseline = resolve(dataRoot, 'baseline');
    mkdirSync(baseline, { recursive: true });
    writeFileSync(resolve(baseline, 'README.md'), 'private repo source\n');

    const ws = await new FsWorkspacePreparer().prepare('sbx-1', { baselinePath: baseline });

    expect(mode(resolve(dataRoot, 'workspaces'))).toBe(0o700);
    expect(mode(ws.hostPath)).toBe(0o777);
    // the baseline really landed inside (the 0700 parent does not break the copy)
    expect(statSync(resolve(ws.hostPath, 'README.md')).isFile()).toBe(true);
  });

  it('tightens a pre-existing world-traversable root', async () => {
    // a root created before this hardening (or recreated 0755 by a deploy script)
    // must be repaired on the next prepare, not left as it was found.
    const root = resolve(dataRoot, 'workspaces');
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o755);
    expect(mode(root)).toBe(0o755);

    await new FsWorkspacePreparer().prepare('sbx-2', { baselinePath: resolve(dataRoot, 'none') });

    expect(mode(root)).toBe(0o700);
  });
});
