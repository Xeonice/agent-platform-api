import { describe, expect, it } from 'vitest';
import { asProjectId, asSandboxId } from '@platform/shared-kernel';
import { SandboxFacadeAdapter } from '../../../packages/modules/sandbox/src/application/sandbox-facade.adapter';
import { Sandbox } from '../../../packages/modules/sandbox/src/domain/entities/sandbox.entity';
import { harness } from '../../support/sandbox-rig';

describe('readonly credential deletion impact', () => {
  it('separates actual bindings from the selected Agent tasks that have not received credentials', async () => {
    const h = harness();
    const add = (
      id: string,
      runtime: string,
      phase: 'pending' | 'creating' | 'running' | 'destroyed',
    ) => {
      const sandbox = Sandbox.create({
        id: asSandboxId(id),
        projectId: asProjectId('prj-1'),
        runtime,
        provider: h.provider.name,
        imageRef: '',
        headless: false,
        timeoutMinutes: null,
        idleTimeoutSec: 1800,
        now: h.clock.now(),
      });
      if (phase === 'destroyed') {
        sandbox.transitionTo('destroying', 'user', h.clock.now());
        sandbox.transitionTo('destroyed', 'user', h.clock.now());
      } else if (phase !== 'pending') {
        for (const status of ['scheduling', 'preparing-workspace', 'creating'] as const)
          sandbox.transitionTo(status, 'scheduler', h.clock.now());
        if (phase === 'running') {
          sandbox.bindRuntime({ providerSandboxId: `${id}-instance`, workspacePath: `/tmp/${id}` });
          sandbox.transitionTo('starting', 'scheduler', h.clock.now());
          sandbox.transitionTo('running', 'scheduler', h.clock.now());
        }
      }
      h.uow.run((tx) => h.repo.saveSync(tx, sandbox));
    };
    add('bound-claude', 'claude-code', 'running');
    add('bound-creating', 'claude-code', 'creating');
    add('unbound-claude', 'claude-code', 'pending');
    add('unbound-codex', 'codex', 'pending');
    add('codex-running', 'codex', 'running');
    add('already-gone', 'claude-code', 'destroyed');
    const facade = new SandboxFacadeAdapter(
      h.repo,
      h.registry,
      h.workspace,
      h.uow,
      h.service,
      h.waiting,
    );
    const impact = await facade.credentialImpact('claude-code', [
      'bound-claude',
      'bound-creating',
      'already-gone',
    ]);
    expect(impact.affectedTasks.map((task) => task.id)).toEqual(['bound-claude', 'bound-creating']);
    expect(impact.preparingTasks.map((task) => task.id)).toEqual(['unbound-claude']);
    expect(h.provider.calls).toEqual([]);
    expect(h.wsCalls).toEqual([]);
    expect((await h.repo.findAll()).length).toBe(6);
  });
});
