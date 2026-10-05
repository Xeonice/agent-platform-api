import { describe, expect, it } from 'vitest';
import { asProjectId, asSandboxId } from '@platform/shared-kernel';
import { Sandbox } from '../../../packages/modules/sandbox/src/domain/entities/sandbox.entity';
import { SqliteSandboxRepository } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/sandbox.repository.impl';
import { SandboxWriteConflictError } from '../../../packages/modules/sandbox/src/domain/errors/write-conflict.error';
import { currentDatabase } from '../../support/sqlite';

describe('delete intent wins over stale persisted task writers', () => {
  it('a stale provisioner cannot overwrite deletion state/history or recreate a deleted record', async () => {
    const h = currentDatabase();
    try {
      const repo = new SqliteSandboxRepository(h.db);
      const sandbox = Sandbox.create({
        id: asSandboxId('task'),
        projectId: asProjectId('project'),
        runtime: 'codex',
        provider: 'aio',
        imageRef: '',
        headless: false,
        timeoutMinutes: null,
        idleTimeoutSec: 1800,
        now: new Date(0),
      });
      h.uow.run((tx) => repo.saveSync(tx, sandbox));
      const provisioner = (await repo.findById(sandbox.id))!;
      const deleter = (await repo.findById(sandbox.id))!;
      deleter.transitionTo('destroying', 'user', new Date(1));
      h.uow.run((tx) => repo.saveSync(tx, deleter));
      provisioner.transitionTo('scheduling', 'scheduler', new Date(2));
      expect(() => h.uow.run((tx) => repo.saveSync(tx, provisioner))).toThrow(
        SandboxWriteConflictError,
      );
      const persisted = (await repo.findById(sandbox.id))!;
      expect(persisted.status).toBe('destroying');
      expect(persisted.transitions.map((event) => event.to)).toEqual(['pending', 'destroying']);
      deleter.transitionTo('destroyed', 'user', new Date(3));
      h.uow.run((tx) => repo.saveSync(tx, deleter));
      const late = (await repo.findById(sandbox.id))!;
      h.uow.run((tx) => repo.deleteByProjectSync(tx, sandbox.projectId));
      expect(() => h.uow.run((tx) => repo.saveSync(tx, late))).toThrow(SandboxWriteConflictError);
      expect(await repo.findAll()).toEqual([]);
    } finally {
      h.sqlite.close();
    }
  });
});
