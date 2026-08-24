/**
 * BaselineManager port (docs/backend/03 §7.1). Owns the `DATA_ROOT/baselines/<id>`
 * directory lifecycle for the project context. Module-internal port in `domain`
 * so application + infrastructure share it without crossing the boundary. (The
 * baseline→workspace COPY is the sandbox context's job — this only manages the
 * baseline dir itself.)
 */
export interface BaselineManager {
  /** create an empty baseline dir (for empty projects / convert-to-empty). */
  createEmptyDir(path: string): Promise<void>;
  /** remove a baseline dir (delete-project / failed-clone cleanup). Idempotent. */
  removeDir(path: string): Promise<void>;
  /** total bytes under a dir (for baseline_size_bytes). 0 if missing. */
  directorySizeBytes(path: string): Promise<number>;
  /**
   * Free bytes on the FILESYSTEM that would hold `path` (03 §7.2★ 磁盘预检). The path
   * itself need not exist yet — the deepest existing ancestor is probed, which is the
   * normal case since the check runs BEFORE the baseline dir is created.
   */
  availableBytes(path: string): Promise<number>;
}

export const BASELINE_MANAGER = Symbol('BaselineManager');
