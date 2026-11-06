import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeInstallOrchestratorService } from '../../../packages/modules/runtime/src/application/runtime-install.orchestrator';
import { SqliteRuntimeInstallationRepository } from '../../../packages/modules/runtime/src/infrastructure/persistence/sqlite/runtime-installation.repository.impl';
import { DefaultRuntimeAdapterRegistry } from '../../../packages/modules/runtime/src/infrastructure/registry/runtime-adapter.registry';
import { CodexAdapter } from '../../../packages/modules/runtime/src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../../packages/modules/runtime/src/infrastructure/adapters/claude-code/claude-code.adapter';
import { AGENT_CLI_VERSIONS } from '../../../packages/modules/runtime/src/infrastructure/adapters/agent-cli-versions';
import { currentDatabase, seedImageManifest } from '../../support/sqlite';

const closers: (() => void)[] = [];
afterEach(() =>
  closers
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);

describe('CLI release runtime installation · actual orchestrator and SQLite', () => {
  it.each([
    [
      'codex',
      'codex',
      '@openai/codex',
      'codex-cli 0.150.1',
      `codex-cli ${AGENT_CLI_VERSIONS.codex}`,
    ],
    [
      'claude-code',
      'claude',
      '@anthropic-ai/claude-code',
      '2.1.251 (Claude Code)',
      `${AGENT_CLI_VERSIONS['claude-code']} (Claude Code)`,
    ],
  ] as const)(
    '%s keeps a usable older binary and installs the release pin only when missing',
    async (runtimeId, binary, packageName, oldVersion, newVersion) => {
      const database = currentDatabase();
      closers.push(() => database.sqlite.close());
      const manifest = seedImageManifest(database.sqlite);
      for (const id of ['existing-sandbox', 'new-sandbox'])
        database.sqlite
          .prepare(
            'INSERT INTO sandboxes (id,project_id,runtime,provider,image_ref,status,headless,created_at,updated_at) VALUES (?,?,?,?,?,?,0,0,0)',
          )
          .run(id, 'project', runtimeId, 'aio', manifest, 'starting');
      const repository = new SqliteRuntimeInstallationRepository(database.db);
      let id = 0;
      const orchestrator = new RuntimeInstallOrchestratorService(
        new DefaultRuntimeAdapterRegistry(new CodexAdapter(), new ClaudeCodeAdapter()),
        repository,
        database.uow,
        { publishInTx: () => {}, subscribe: () => () => {} },
        { now: () => new Date('2026-10-17T00:00:00Z') },
        { next: () => `cli-install-${++id}` },
        { record: () => {} },
      );
      const image = {
        ref: 'registry.test/custom:fixed',
        digest: `sha256:${'a'.repeat(64)}`,
        supportedRuntimes: [],
      };
      for (const existing of [true, false]) {
        const calls: string[][] = [];
        let installed = existing;
        const version = existing ? oldVersion : newVersion;
        const sandboxId = existing ? 'existing-sandbox' : 'new-sandbox';
        await orchestrator.ensureInstalled({
          sandboxId,
          runtimeId,
          image,
          exec: async (cmd) => {
            calls.push(cmd);
            if (cmd[0] === 'sh' && cmd[2]?.startsWith('npm install -g ')) {
              installed = true;
              return { stdout: '', stderr: '', exitCode: 0 };
            }
            const probe = cmd[0] === binary && cmd[1] === '--version';
            return {
              stdout: installed ? (probe ? version : `/test/bin/${binary}`) : '',
              stderr: '',
              exitCode: installed ? 0 : 1,
            };
          },
        });
        expect(calls.filter((cmd) => cmd[2]?.startsWith('npm install -g '))).toEqual(
          existing
            ? []
            : [['sh', '-c', `npm install -g ${packageName}@${AGENT_CLI_VERSIONS[runtimeId]}`]],
        );
        expect(await repository.find(sandboxId, runtimeId)).toMatchObject({
          status: 'installed',
          versionDetected: version,
        });
      }
    },
  );
});
