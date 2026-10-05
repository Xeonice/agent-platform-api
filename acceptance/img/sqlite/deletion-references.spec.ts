import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';
import { asProjectId, asSandboxId } from '@platform/shared-kernel';
import { SandboxFacadeAdapter } from '../../../packages/modules/sandbox/src/application/sandbox-facade.adapter';
import { Sandbox } from '../../../packages/modules/sandbox/src/domain/entities/sandbox.entity';
import { SqliteSandboxRepository } from '../../../packages/modules/sandbox/src/infrastructure/persistence/sqlite/sandbox.repository.impl';
import { SqliteUnitOfWork } from '../../../apps/api/src/platform/persistence/unit-of-work.impl';
import { WaitingInputDetector } from '../../../packages/modules/terminal/src/infrastructure/waiting-input/waiting-input.detector';
import { WaitingInputService } from '../../../packages/modules/terminal/src/application/waiting-input.service';
import { PromptHeuristic } from '../../../packages/modules/terminal/src/domain/services/prompt-heuristic';
import { seedImageManifest } from '../../support/sqlite';
import { harness } from '../../support/sandbox-rig';

describe('AC-IMG-034 image-reference deletion projection', () => {
  it('reads actual project/task names, retains stopped/failed references, excludes destroyed, and projects genuine waiting without writes', async () => {
    const sqlite = new Database(':memory:');
    try {
      const db = drizzle(sqlite);
      migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });
      const manifestId = seedImageManifest(sqlite);
      sqlite
        .prepare(
          `insert into projects
        (id,name,source_type,clone_status,baseline_path,created_at,updated_at)
        values ('project','实际项目名','empty','ready','/tmp/project',0,0)`,
        )
        .run();
      const repo = new SqliteSandboxRepository(db);
      const uow = new SqliteUnitOfWork(sqlite);
      const h = harness();
      let now = 0;
      const observer = new WaitingInputDetector(
        { now: () => new Date(now) },
        {
          broadcast: () => {
            /* No WS client in this read-only projection test. */
          },
        },
        { silenceSec: 10, promptPatterns: PromptHeuristic.DEFAULT_PATTERNS.map((p) => p.source) },
      );
      const query = new WaitingInputService(observer);
      const facade = new SandboxFacadeAdapter(repo, h.registry, h.workspace, uow, h.service, query);
      for (const phase of ['running', 'stopped', 'failed', 'destroyed'] as const) {
        const sandbox = Sandbox.create({
          id: asSandboxId(phase),
          projectId: asProjectId('project'),
          runtime: 'claude-code',
          provider: 'aio',
          imageRef: manifestId,
          headless: false,
          timeoutMinutes: null,
          idleTimeoutSec: 1800,
          now: h.clock.now(),
        });
        if (phase === 'failed') {
          sandbox.transitionTo('scheduling', 'scheduler', h.clock.now());
          sandbox.transitionTo('failed', 'scheduler', h.clock.now());
        } else if (phase === 'destroyed') {
          sandbox.transitionTo('destroying', 'user', h.clock.now());
          sandbox.transitionTo('destroyed', 'user', h.clock.now());
        } else {
          for (const state of [
            'scheduling',
            'preparing-workspace',
            'creating',
            'starting',
            'running',
          ] as const)
            sandbox.transitionTo(state, 'scheduler', h.clock.now());
          if (phase === 'stopped') {
            sandbox.transitionTo('stopping', 'user', h.clock.now());
            sandbox.transitionTo('stopped', 'user', h.clock.now());
          }
        }
        uow.run((tx) => repo.saveSync(tx, sandbox));
      }
      observer.attach('tty', 'running');
      observer.output('tty', '❯ ');
      now = 11_000;
      observer.tick();
      const changes = sqlite.prepare('select total_changes() as count').get();
      const references = await facade.imageReferences(manifestId);
      expect(references).toHaveLength(3);
      expect(references.map((task) => task.status)).toEqual(['failed', 'waiting_input', 'stopped']);
      expect(
        references.every(
          (task) => task.projectId === 'project' && task.projectName === '实际项目名',
        ),
      ).toBe(true);
      expect(references.every((task) => task.name !== '')).toBe(true);
      expect(await facade.imageReferences('another-version')).toEqual([]);
      expect(sqlite.prepare('select total_changes() as count').get()).toEqual(changes);
      expect((await repo.findById(asSandboxId('destroyed')))?.imageRef).toBe(manifestId);
      expect(h.provider.calls).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
