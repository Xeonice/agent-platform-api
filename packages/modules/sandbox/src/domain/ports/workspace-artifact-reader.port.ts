/** Read retained artifacts after the provider instance has been removed. */
export interface WorkspaceArtifactReader {
  open(
    workspacePath: string,
    name: string,
  ): Promise<{ stream: NodeJS.ReadableStream; size: number } | null>;
}

export const WORKSPACE_ARTIFACT_READER = Symbol('WorkspaceArtifactReader');
