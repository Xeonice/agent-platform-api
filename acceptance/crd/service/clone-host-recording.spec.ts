import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimpleGitCloner } from '../../../packages/modules/project/src/infrastructure/git/git-cloner';
import { CloneError } from '../../../packages/modules/project/src/domain/ports/git-cloner.port';

const git = vi.hoisted(() => ({ clone: vi.fn(), env: vi.fn(), outputHandler: vi.fn() }));
vi.mock('simple-git', () => ({ simpleGit: () => git }));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'clone-host-success-'));
  git.clone.mockReset().mockResolvedValue(undefined);
  git.env.mockReturnValue(git);
  git.outputHandler.mockReturnValue(git);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('clone commits host-fingerprint metadata only after successful SSH auth', () => {
  const input = () => ({
    repoUrl: 'ssh://git@git.acme.example.com/repo.git',
    repoBranch: null,
    destPath: join(root, 'repo'),
    timeoutMs: 15_000,
    signal: new AbortController().signal,
    onProgress: () => {
      /* fixture has no progress */
    },
  });
  it('waits for actual clone success before asking the opaque auth handle to record', async () => {
    const record = vi.fn(async () => {
      expect(git.clone).toHaveBeenCalledOnce();
    });
    await new SimpleGitCloner().clone({ ...input(), recordSuccessfulClone: record });
    expect(record).toHaveBeenCalledOnce();
  });
  it('does not record a host when clone fails authentication', async () => {
    git.clone.mockRejectedValue(new Error('Permission denied (publickey)'));
    const record = vi.fn();
    await expect(
      new SimpleGitCloner().clone({ ...input(), recordSuccessfulClone: record }),
    ).rejects.toBeInstanceOf(CloneError);
    expect(record).not.toHaveBeenCalled();
  });
  it('does not downgrade a completed clone when metadata recording has an IO failure', async () => {
    const record = vi.fn(async () => {
      throw new Error('metadata unavailable');
    });
    await expect(
      new SimpleGitCloner().clone({ ...input(), recordSuccessfulClone: record }),
    ).resolves.toBeUndefined();
    expect(record).toHaveBeenCalledOnce();
  });
});
