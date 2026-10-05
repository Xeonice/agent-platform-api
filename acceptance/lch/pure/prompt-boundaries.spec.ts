import { describe, expect, it } from 'vitest';
import { CreateSandboxSchema, RunAgentTaskSchema } from '@platform/contracts';
import { InitialTask } from '../../../packages/modules/sandbox/src/domain/value-objects/initial-task.vo';
describe('task instruction contract and one-shot consumption', () => {
  it.each(['字', '😀', 'a'])(
    'accepts 8000 Unicode code points for %s on both task entrances',
    (character) => {
      const prompt = character.repeat(8000);
      expect(
        CreateSandboxSchema.parse({ projectId: 'p', runtime: 'codex', initialPrompt: prompt })
          .initialPrompt,
      ).toBe(prompt);
      expect(RunAgentTaskSchema.parse({ prompt }).prompt).toBe(prompt);
      expect(InitialTask.create({ prompt }).prompt).toBe(prompt);
    },
  );
  it.each(['字', '😀', 'a'])(
    'rejects 8001 Unicode code points for %s before orchestration',
    (character) => {
      const prompt = character.repeat(8001);
      expect(
        CreateSandboxSchema.safeParse({ projectId: 'p', runtime: 'codex', initialPrompt: prompt })
          .success,
      ).toBe(false);
      expect(RunAgentTaskSchema.safeParse({ prompt }).success).toBe(false);
      expect(() => InitialTask.create({ prompt })).toThrow();
    },
  );
  it('normalizes blank interactive input while a run requires actual text', () => {
    expect(InitialTask.create({ prompt: '\n  ' }).isPending).toBe(false);
    expect(RunAgentTaskSchema.safeParse({ prompt: '\n  ' }).success).toBe(false);
  });
  it('consumption is immutable and restart cannot replay a consumed instruction', () => {
    const pending = InitialTask.create({ prompt: '  implement parser  ' });
    const consumed = pending.consume(new Date(1));
    expect(pending.isPending).toBe(true);
    expect(consumed.isPending).toBe(false);
    expect(consumed.prompt).toBe('implement parser');
    expect(() => consumed.consume(new Date(2))).toThrow(/already consumed/);
    expect(() => InitialTask.none().consume(new Date(2))).toThrow(/no initial/);
  });
});
