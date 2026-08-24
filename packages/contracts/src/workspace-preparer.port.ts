/**
 * WorkspacePreparer port (docs/backend/03 §7.6). Prepares the host bind-mount
 * directory that becomes the container's /workspace (audit P0-1). Lives in
 * `contracts` (like the SandboxProvider SPI) so the infrastructure adapter can
 * implement it and the application can depend on it without crossing the
 * application↔infrastructure boundary. S1 makes an empty marked dir (no clone).
 */
export interface PreparedWorkspace {
  /** host absolute path; becomes VolumeMount.source (kind='host-path'). */
  hostPath: string;
}

/**
 * Where the workspace is filled from (03 §7.1): the project's baseline dir is
 * copied (`cp -a --reflink=auto`) into a fresh per-sandbox workspace. An empty
 * project's baseline is an empty dir, so the copy yields an empty workspace.
 */
export interface WorkspaceSource {
  /** host baseline dir to import; must exist (platform guarantees it, 03 §4). */
  baselinePath: string;
  /**
   * Branch to check out in the FRESH COPY once the import is done (03 §7.2★). After a
   * full baseline clone this is a purely LOCAL `git checkout` — no network, no git
   * credential — which is exactly why the baseline is cloned in full. The value was
   * already validated against the baseline's refs at the create door, so a failure
   * here is a real fault, not a bad request. `undefined` ⇒ keep the baseline's own
   * checked-out branch.
   */
  branch?: string;
}

export interface WorkspacePreparer {
  prepare(sandboxId: string, source: WorkspaceSource): Promise<PreparedWorkspace>;
  cleanup(sandboxId: string, opts: { keep: boolean }): Promise<void>;
}

export const WORKSPACE_PREPARER = Symbol('WorkspacePreparer');
