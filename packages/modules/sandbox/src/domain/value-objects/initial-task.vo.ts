import { SandboxInvariantViolationError } from '../errors/invariant-violation.error';

/** Same ceiling as `automations.prompt` — one field, one spec (13 §2.1.1 / 23 §3). */
export const INITIAL_PROMPT_MAX_LENGTH = 8000;

/**
 * `InitialTask` — "WHAT to run" (23 §5.3, invariant I-SBX-10).
 *
 * DELIBERATELY NOT folded into `ExecutionPolicy` (裁决 D-14). `ExecutionPolicy`
 * answers "HOW to run" and is a create-time-once, immutable policy that also carries
 * the cross-field I-SBX-5 assertion (`headless ⟺ timeoutMinutes`). `consumedAt` is
 * the opposite: a RUNTIME, one-shot marker. Merging them would sit a construction-time
 * assertion next to a mutable field and force the whole policy object to be rebuilt
 * every time an instruction is consumed.
 *
 * WHY `consumedAt` EXISTS AT ALL: `stopped → starting` re-runs provision (I-SBX-9).
 * Without this column the same instruction would be replayed — and the previous agent
 * run has very likely already edited files, so a replay is destructive. P22 §2 already
 * tells users a restart is "a NEW agent session", not "redo this task".
 *
 * Immutable: `consume()` returns a NEW instance.
 */
export class InitialTask {
  private constructor(
    readonly prompt: string | undefined,
    readonly consumedAt: Date | undefined,
  ) {}

  /** The empty instruction — a task created with no `initialPrompt`. */
  static none(): InitialTask {
    return new InitialTask(undefined, undefined);
  }

  /**
   * Construct + validate (I-SBX-10). A blank-only prompt is normalised to "none":
   * `"   "` carries no instruction, and treating it as one would start an agent with
   * whitespace and then mark the instruction consumed.
   */
  static create(input: { prompt?: string | null; consumedAt?: Date | null }): InitialTask {
    const raw = input.prompt ?? undefined;
    const prompt = raw !== undefined && raw.trim() !== '' ? raw : undefined;
    const consumedAt = input.consumedAt ?? undefined;
    if (prompt !== undefined && prompt.length > INITIAL_PROMPT_MAX_LENGTH) {
      throw new SandboxInvariantViolationError(
        'I-SBX-10',
        `initialPrompt is ${prompt.length} characters; the limit is ${INITIAL_PROMPT_MAX_LENGTH}`,
      );
    }
    if (consumedAt !== undefined && prompt === undefined) {
      throw new SandboxInvariantViolationError(
        'I-SBX-10',
        'initialPromptConsumedAt is set while there is no instruction to have consumed',
      );
    }
    return new InitialTask(prompt, consumedAt);
  }

  /** True when there is an instruction that has NOT been started yet. */
  get isPending(): boolean {
    return this.prompt !== undefined && this.consumedAt === undefined;
  }

  /**
   * Mark the instruction as started. ONE-SHOT and NOT reversible (I-SBX-10): a second
   * call throws rather than silently re-stamping, because the only way a second call
   * can happen is a bug that would otherwise replay a destructive instruction.
   */
  consume(at: Date): InitialTask {
    if (this.prompt === undefined) {
      throw new SandboxInvariantViolationError(
        'I-SBX-10',
        'there is no initial instruction to consume',
      );
    }
    if (this.consumedAt !== undefined) {
      throw new SandboxInvariantViolationError(
        'I-SBX-10',
        'the initial instruction was already consumed; it must never be replayed',
      );
    }
    return new InitialTask(this.prompt, at);
  }
}
