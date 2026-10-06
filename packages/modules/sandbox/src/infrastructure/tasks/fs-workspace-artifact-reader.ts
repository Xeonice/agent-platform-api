import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { WorkspaceArtifactReader } from '../../domain/ports/workspace-artifact-reader.port';

@Injectable()
export class FsWorkspaceArtifactReader implements WorkspaceArtifactReader {
  async open(
    workspacePath: string,
    name: string,
  ): Promise<{ stream: NodeJS.ReadableStream; size: number } | null> {
    const root = resolve(process.env.DATA_ROOT ?? resolve(process.cwd(), 'data'), 'workspaces');
    const workspace = resolve(workspacePath);
    if (!within(root, workspace)) return null;
    const artifacts = resolve(workspace, '.agent-artifacts');
    const candidate = resolve(artifacts, name);
    if (!within(artifacts, candidate)) return null;
    try {
      // The retained Agent can have left symlinks. Resolve every parent and refuse
      // anything outside this workspace before opening; do not follow a leaf symlink.
      const realRoot = await realpath(root);
      const realWorkspace = await realpath(workspace);
      const realCandidate = await realpath(candidate);
      if (
        !within(realRoot, realWorkspace) ||
        !within(resolve(realWorkspace, '.agent-artifacts'), realCandidate)
      )
        return null;
      const file = await open(realCandidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) {
          await file.close();
          return null;
        }
        return { stream: file.createReadStream({ autoClose: true }), size: stat.size };
      } catch (error) {
        await file.close();
        throw error;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(String(error.code))
      )
        return null;
      throw error;
    }
  }
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
