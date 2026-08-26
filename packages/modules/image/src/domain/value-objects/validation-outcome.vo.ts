/**
 * `ValidationOutcome` — the 三级 verdict (docs/backend/23 §9.4, P21-4 §5/§9).
 *
 * ⚠️ THREE LEVELS, NOT TWO. A `warning` image is still SELECTABLE, with its
 * consequence shown next to the option. Folding it into a boolean would delete the
 * only state that says 「能用，但你该知道这件事」 — e.g. an image that declares
 * `claude-code` in `supportedRuntimes` but does not preinstall it, where the cost is a
 * measured 753s first-run install rather than a failure.
 */
export type ImageValidationStatus = 'pending' | 'valid' | 'warning' | 'invalid';

export interface ValidationFinding {
  path?: string;
  code: string;
  message: string;
}

export class ValidationOutcome {
  private constructor(
    readonly status: ImageValidationStatus,
    readonly errors: readonly ValidationFinding[],
    readonly warnings: readonly ValidationFinding[],
  ) {}

  /** A freshly INSERTed row that has not been judged yet. */
  static pending(): ValidationOutcome {
    return new ValidationOutcome('pending', [], []);
  }

  /**
   * Derive the level from the findings — the status is never passed in separately.
   *
   * ⚠️ THAT IS THE POINT: a caller-supplied status could disagree with the findings
   * (`invalid` with an empty `errors[]`, or `valid` alongside errors), and 13 §2.4.2
   * pins 「`invalid` 时 validation_errors 非空」 as a stored invariant that nothing
   * would then be enforcing. Deriving makes the two physically incapable of drifting.
   */
  static from(
    errors: readonly ValidationFinding[],
    warnings: readonly ValidationFinding[],
  ): ValidationOutcome {
    const status: ImageValidationStatus =
      errors.length > 0 ? 'invalid' : warnings.length > 0 ? 'warning' : 'valid';
    return new ValidationOutcome(status, [...errors], [...warnings]);
  }

  static rehydrate(
    status: ImageValidationStatus,
    errors: readonly ValidationFinding[],
    warnings: readonly ValidationFinding[],
  ): ValidationOutcome {
    return new ValidationOutcome(status, [...errors], [...warnings]);
  }

  /** 可选 = 不是 invalid (I-IMG-2). `pending` and `warning` are both选得上. */
  get selectable(): boolean {
    return this.status !== 'invalid';
  }
}
