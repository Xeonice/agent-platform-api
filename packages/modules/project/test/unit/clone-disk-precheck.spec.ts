import { afterEach, describe, it, expect } from 'vitest';
import { classifyCloneError } from '../../src/infrastructure/git/error.classifier';
import { CloneProjectWorkflow } from '../../src/application/clone-project.workflow';
import {
  FakeBaselineManager,
  InMemoryProjectRepo,
  NoGitCredentialFacade,
  RecordingBroadcaster,
  RecordingCloner,
  directUow,
  fixedClock,
  gitProject,
} from './_project-doubles';

const GIB = 1024 * 1024 * 1024;

interface Wired {
  workflow: CloneProjectWorkflow;
  repo: InMemoryProjectRepo;
  cloner: RecordingCloner;
  baseline: FakeBaselineManager;
  ws: RecordingBroadcaster;
}

function wire(availableBytes: number): Wired {
  const repo = new InMemoryProjectRepo();
  repo.add(gitProject('prj-1'));
  const cloner = new RecordingCloner();
  const baseline = new FakeBaselineManager();
  baseline.available = availableBytes;
  const ws = new RecordingBroadcaster();
  const workflow = new CloneProjectWorkflow(
    repo,
    directUow,
    fixedClock(),
    cloner,
    baseline,
    ws,
    new NoGitCredentialFacade(),
  );
  return { workflow, repo, cloner, baseline, ws };
}

/** `enqueue` fires the clone as a background promise; drain the microtask queue. */
async function runClone(w: Wired): Promise<void> {
  w.workflow.enqueue('prj-1');
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
}

/**
 * 磁盘预检 (docs/backend/03 §7.2★): 「从写爆之后认出来」改成「写之前拦住」.
 *
 * ── WHY THIS IS NOT A COSMETIC REORDERING ─────────────────────────────────────────
 * Before it, `DISK_INSUFFICIENT` existed ONLY as a stderr pattern — the platform found
 * out the disk was full by filling it, after which a half-written baseline still had to
 * be `rm -rf`'d. Under shallow clones that was an edge case; a full clone (03 §7.2★)
 * can be ten times the size, which turns it into the ordinary outcome on a tight disk.
 *
 * MUTATION: delete the `await this.assertDiskSpace(dest)` line in `runClone` and the
 * first test goes red — `provider`-side `clone()` gets called, which is exactly the
 * write the check exists to prevent.
 */
describe('磁盘预检 refuses BEFORE the clone writes anything (03 §7.2★)', () => {
  const previous = process.env.CLONE_MIN_FREE_BYTES;
  afterEach(() => {
    if (previous === undefined) delete process.env.CLONE_MIN_FREE_BYTES;
    else process.env.CLONE_MIN_FREE_BYTES = previous;
  });

  it('too little free space ⇒ git is never invoked, and the project fails DISK_INSUFFICIENT', async () => {
    const w = wire(64 * 1024); // 64 KiB free, default floor is 1 GiB
    await runClone(w);

    // ① the point of a PRE-check: nothing was handed to git at all.
    expect(w.cloner.requests).toEqual([]);
    // ② the failure is still the taxonomy code the frontend branches on (03 §7.5),
    //    not some new platform-only error nobody has a sentence for.
    const project = await w.repo.findById('prj-1');
    expect(project?.cloneStatus).toBe('failed');
    expect(project?.cloneErrorCode).toBe('DISK_INSUFFICIENT');
    // ③ …and it is broadcast, so a user watching the progress card learns why.
    expect(w.ws.events).toContainEqual({
      event: 'project.clone_progress',
      projectId: 'prj-1',
      phase: 'failed',
      errorCode: 'DISK_INSUFFICIENT',
    });
  });

  it('enough free space ⇒ the clone runs exactly as before', async () => {
    const w = wire(50 * GIB);
    await runClone(w);

    expect(w.cloner.requests).toHaveLength(1);
    expect(w.cloner.requests[0].destPath).toBe('/data/baselines/prj-1');
    expect((await w.repo.findById('prj-1'))?.cloneStatus).toBe('ready');
  });

  it('the floor is configurable, and the check reads the DESTINATION filesystem', async () => {
    process.env.CLONE_MIN_FREE_BYTES = String(10 * GIB);
    const w = wire(5 * GIB); // plenty by default, not enough under this floor
    await runClone(w);

    expect(w.cloner.requests).toEqual([]);
    expect((await w.repo.findById('prj-1'))?.cloneErrorCode).toBe('DISK_INSUFFICIENT');
  });

  it('the AFTER-THE-FACT classifier stays — the two are not alternatives', () => {
    // 03 §7.2★ says so explicitly: a pre-check cannot catch 「克隆途中别的进程把盘吃满」.
    // If someone ever deletes the ENOSPC branch as "superseded", this is the guard.
    expect(classifyCloneError('error: write: No space left on device')).toBe('DISK_INSUFFICIENT');
    expect(classifyCloneError('fatal: ENOSPC: no space left')).toBe('DISK_INSUFFICIENT');
  });
});
