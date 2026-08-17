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

export interface WorkspacePreparer {
  prepare(sandboxId: string): Promise<PreparedWorkspace>;
  cleanup(sandboxId: string, opts: { keep: boolean }): Promise<void>;
}

export const WORKSPACE_PREPARER = Symbol('WorkspacePreparer');
