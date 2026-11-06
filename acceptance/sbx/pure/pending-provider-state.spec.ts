import { describe, expect, it } from 'vitest';
import { asProjectId, asSandboxId } from '@platform/shared-kernel/pure';
import { Sandbox } from '../../../packages/modules/sandbox/src/domain/entities/sandbox.entity';
const pending = () =>
  Sandbox.create({
    id: asSandboxId('task'),
    projectId: asProjectId('project'),
    runtime: 'codex',
    provider: 'third-party',
    imageRef: 'fixture',
    headless: false,
    timeoutMinutes: null,
    idleTimeoutSec: 1800,
    now: new Date(0),
  });
describe('provider-owned pending state is distinct from a runtime binding', () => {
  it('accepts arbitrary opaque provider keys once, detaches caller mutation and never creates a handle', () => {
    const sandbox = pending(),
      state = { privateExtension: { selection: 'original' } };
    sandbox.setPendingProviderState(state);
    state.privateExtension.selection = 'different';
    expect(sandbox.providerSandboxId).toBeNull();
    expect(sandbox.workspacePath).toBeNull();
    expect(sandbox.providerState).toEqual({ privateExtension: { selection: 'original' } });
    expect(() =>
      sandbox.setPendingProviderState({ privateExtension: { selection: 'different' } }),
    ).toThrow('ALREADY_BOUND');
  });
  it('refuses late pending state and permits the subsequent real provider response to replace it', () => {
    const sandbox = pending();
    sandbox.setPendingProviderState({ opaque: 'planned' });
    sandbox.bindRuntime({
      providerSandboxId: 'actual-provider-id',
      workspacePath: '/fixture',
      providerState: { opaque: 'actual' },
    });
    expect(sandbox.providerState).toEqual({ opaque: 'actual' });
    expect(sandbox.providerSandboxId).toBe('actual-provider-id');
    expect(() => sandbox.setPendingProviderState({ opaque: 'replacement' })).toThrow(
      'ALREADY_BOUND',
    );
    const late = pending();
    late.transitionTo('scheduling', 'scheduler', new Date(1));
    expect(() => late.setPendingProviderState({ opaque: 'late' })).toThrow('ALREADY_BOUND');
  });
});
