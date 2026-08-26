import type { EnvVarSet } from '../value-objects/env-var-set.vo';

/** Which layer a merged variable came from (23 §9.4 `EnvSource`, P21-4 §10.3). */
export type EnvSource = 'image' | 'project' | 'task';

export interface MergedEnvEntry {
  key: string;
  value: string;
  source: EnvSource;
  /** `true` ⇒ a lower layer also set this key; the UI shows 「⚠️ 该变量被覆盖」. */
  overridden: boolean;
}

export type MergedEnv = MergedEnvEntry[];

/**
 * `EnvMergeService` — three layers, later wins (docs/backend/23 §9.5, P21-4 §10.3).
 *
 * ⚠️ IT DOES NOT TOUCH CREDENTIALS, AND THAT IS THE DESIGN. 「凭证永远赢」 is
 * guaranteed by ORDER, not by a blacklist inside this function: the application layer
 * writes credential env LAST, on top of whatever this returns (05 §4.1). Teaching the
 * merge about credentials would put a credential concern inside the image domain and
 * give the platform two places that both half-decide the same thing.
 *
 * Keeping it a PURE function is also what lets 25 §3.5 test the merge exhaustively
 * with no mocks at all.
 */
export function mergeEnv(image: EnvVarSet, project: EnvVarSet, task: EnvVarSet): MergedEnv {
  const layers: Array<[EnvSource, EnvVarSet]> = [
    ['image', image],
    ['project', project],
    ['task', task],
  ];
  const byKey = new Map<string, MergedEnvEntry>();
  for (const [source, set] of layers) {
    for (const entry of set.entries) {
      const existing = byKey.get(entry.key);
      byKey.set(entry.key, {
        key: entry.key,
        value: entry.value,
        source,
        // `overridden` marks the SURVIVOR as 「it replaced something」 — that is what
        // the UI badge means (「该变量被覆盖」 is rendered on the row the user sees,
        // and the row the user sees is the winner).
        overridden: existing !== undefined,
      });
    }
  }
  return [...byKey.values()];
}
