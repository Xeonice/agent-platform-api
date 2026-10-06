import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsWorkspaceArtifactReader } from '../../../packages/modules/sandbox/src/infrastructure/tasks/fs-workspace-artifact-reader';
import { AgentTaskApplicationService } from '../../../packages/modules/sandbox/src/application/agent-task.service';
import { AutomationTaskLauncherAdapter } from '../../../packages/modules/sandbox/src/application/automation-task-launcher.adapter';
import { harness, waitForStatus } from '../../support/sandbox-rig';

let root: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.DATA_ROOT;
  root = await mkdtemp(join(tmpdir(), 'retained-artifact-'));
  process.env.DATA_ROOT = root;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.DATA_ROOT;
  else process.env.DATA_ROOT = previous;
  await rm(root, { recursive: true, force: true });
});

async function textOf(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

describe('retained task artifacts', () => {
  it('streams a completed artifact after automatic provider teardown without using its file plane', async () => {
    const h = harness();
    const workspacePath = join(root, 'workspaces', 'sbx-1');
    await mkdir(join(workspacePath, '.agent-artifacts'), { recursive: true });
    await writeFile(join(workspacePath, '.agent-artifacts', 'report.txt'), 'retained report');
    const prepare = h.workspace.prepare.bind(h.workspace);
    h.workspace.prepare = async (...args) => ({
      ...(await prepare(...args)),
      hostPath: workspacePath,
    });
    h.provider.files!.files.set(
      '/workspace/.agent-artifacts/report.txt',
      Buffer.from('retained report'),
    );
    const adapter = new AutomationTaskLauncherAdapter(
      h.service,
      h.taskService,
      h.repo,
      h.taskRepo,
      h.clock,
      h.uow,
      h.events,
      h.projectFacade,
    );
    const { sandboxId } = await adapter.createSandbox({
      projectId: 'prj-1',
      runtimeId: 'claude-code',
      prompt: 'write report',
      timeoutMinutes: 30,
      automationId: 'aut-deleted',
      automationName: 'Deleted rule',
      artifactRetentionDays: 7,
    });
    await waitForStatus(h.service, sandboxId, 'running');
    const task = await h.taskService.run(sandboxId, 'claude-code', {
      prompt: 'report',
      timeoutMinutes: 30,
    });
    [...h.provider.jobs!.jobs.values()][0].finish(0);
    for (
      let count = 0;
      count < 200 && (await h.taskService.get(sandboxId, task.id)).status !== 'succeeded';
      count++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    await adapter.reconcileFinished();
    h.provider.files!.openFileStream = async () => {
      throw new Error('provider no longer exists');
    };
    const service = new AgentTaskApplicationService(
      h.taskRepo,
      h.repo,
      h.registry,
      h.runtimes,
      h.taskWorkflow,
      new FsWorkspaceArtifactReader(),
    );
    const artifact = await service.openArtifact(sandboxId, task.id, 'report.txt');
    expect(artifact.size).toBe(Buffer.byteLength('retained report'));
    expect(await textOf(artifact.stream)).toBe('retained report');
    h.stopPumps();
  });

  it('refuses traversal, an outside workspace, and symlinks escaping the artifact directory', async () => {
    const workspace = join(root, 'workspaces', 'sbx');
    await mkdir(join(workspace, '.agent-artifacts'), { recursive: true });
    await writeFile(join(root, 'secret'), 'must not leak');
    await symlink(join(root, 'secret'), join(workspace, '.agent-artifacts', 'outside'));
    const reader = new FsWorkspaceArtifactReader();
    expect(await reader.open(workspace, '../../../secret')).toBeNull();
    expect(await reader.open(root, 'secret')).toBeNull();
    expect(await reader.open(workspace, 'outside')).toBeNull();
  });
});
