import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { asProjectId, asSandboxId } from '@platform/shared-kernel';
import { SandboxFacadeAdapter } from '../../../packages/modules/sandbox/src/application/sandbox-facade.adapter';
import { Sandbox } from '../../../packages/modules/sandbox/src/domain/entities/sandbox.entity';
import { SqliteSandboxRepository } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/sandbox.repository.impl';
import { FsWorkspacePreparer } from '../../../packages/modules/sandbox/src/infrastructure/workspace/workspace-preparer';
import { SqliteUnitOfWork } from '../../../apps/api/src/platform/persistence/unit-of-work.impl';
import { harness } from '../../support/sandbox-rig';

let sqlite: Database.Database;
let root: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.DATA_ROOT;
  root = await mkdtemp(join(tmpdir(), 'project-cleanup-'));
  process.env.DATA_ROOT = root;
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
});
afterEach(async () => {
  sqlite.close();
  if (previous === undefined) delete process.env.DATA_ROOT;
  else process.env.DATA_ROOT = previous;
  await rm(root, { recursive: true, force: true });
});

function setup() {
  const h = harness();
  const repo = new SqliteSandboxRepository(drizzle(sqlite));
  const uow = new SqliteUnitOfWork(sqlite);
  const workspace = new FsWorkspacePreparer();
  const facade = (): SandboxFacadeAdapter =>
    new SandboxFacadeAdapter(
      new SqliteSandboxRepository(drizzle(sqlite)),
      h.registry,
      workspace,
      uow,
      h.service,
      h.waiting,
    );
  return { h, repo, uow, facade };
}

function createSandbox(status: 'pending' | 'stopped', workspacePath: string): Sandbox {
  const now = new Date('2026-10-05T00:00:00Z');
  const sandbox = Sandbox.create({
    id: asSandboxId('sbx-cleanup'),
    projectId: asProjectId('prj-cleanup'),
    runtime: 'claude-code',
    provider: 'aio',
    imageRef: '',
    headless: false,
    timeoutMinutes: null,
    idleTimeoutSec: 1800,
    now,
  });
  if (status === 'stopped') {
    for (const phase of ['scheduling', 'preparing-workspace', 'creating'] as const)
      sandbox.transitionTo(phase, 'scheduler', now);
    sandbox.bindRuntime({ providerSandboxId: 'provider-instance', workspacePath });
    for (const phase of ['starting', 'running', 'stopping', 'stopped'] as const)
      sandbox.transitionTo(phase, 'scheduler', now);
  }
  return sandbox;
}

describe('committed project task cleanup recovery', () => {
  it('recovers provider and code-copy cleanup with a new adapter after a post-commit IO failure', async () => {
    const { h, repo, uow, facade } = setup();
    const path = join(root, 'workspaces', 'sbx-cleanup');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'code.txt'), 'task code');
    const sandbox = createSandbox('stopped', path);
    uow.run((tx) => repo.saveSync(tx, sandbox));
    const first = facade();
    const paths = uow.run((tx) => first.deleteByProjectSync(tx, sandbox.projectId));
    expect(await repo.findById(sandbox.id)).toBeNull();
    h.provider.destroy = async () => {
      throw new Error('provider offline');
    };
    await first.removeProjectWorkspaces(paths);
    expect(await readFile(join(path, 'code.txt'), 'utf8')).toBe('task code');
    expect(await repo.listPendingProjectCleanup()).toHaveLength(1);
    h.provider.destroy = async () => {
      /* provider recovered */
    };
    await facade().retryPending();
    expect(await repo.listPendingProjectCleanup()).toHaveLength(0);
    await expect(readFile(join(path, 'code.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back both task deletion and cleanup jobs when the project transaction fails', async () => {
    const { repo, uow, facade } = setup();
    const path = join(root, 'workspaces', 'sbx-cleanup');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'code.txt'), 'original code');
    const sandbox = createSandbox('stopped', path);
    uow.run((tx) => repo.saveSync(tx, sandbox));
    const adapter = facade();
    expect(() =>
      uow.run((tx) => {
        adapter.deleteByProjectSync(tx, sandbox.projectId);
        throw new Error('project write failed');
      }),
    ).toThrow('project write failed');
    await adapter.retryPending();
    expect((await repo.findById(sandbox.id))?.status).toBe('stopped');
    expect(await repo.listPendingProjectCleanup()).toEqual([]);
    expect(await readFile(join(path, 'code.txt'), 'utf8')).toBe('original code');
  });

  it('returns the dedicated conflict code for a live task inside the transaction', async () => {
    const { repo, uow, facade } = setup();
    const sandbox = createSandbox('pending', join(root, 'workspaces', 'sbx-cleanup'));
    uow.run((tx) => repo.saveSync(tx, sandbox));
    let caught: unknown;
    try {
      uow.run((tx) => facade().deleteByProjectSync(tx, sandbox.projectId));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({
      code: 'PROJECT_HAS_ACTIVE_TASKS',
      details: [{ id: sandbox.id, name: sandbox.name }],
    });
    expect(await repo.listPendingProjectCleanup()).toEqual([]);
  });
});
