import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResolvedImageSpec } from '@platform/contracts';
import { CodexAdapter } from '../../../packages/modules/runtime/src/infrastructure/adapters/codex/codex.adapter';
import { ClaudeCodeAdapter } from '../../../packages/modules/runtime/src/infrastructure/adapters/claude-code/claude-code.adapter';
import { AGENT_CLI_VERSIONS } from '../../../packages/modules/runtime/src/infrastructure/adapters/agent-cli-versions';

const image: ResolvedImageSpec = {
  ref: 'registry.test/custom:fixed',
  digest: `sha256:${'a'.repeat(64)}`,
  entrypoint: ['/bin/sh'],
  supportedRuntimes: [],
};

describe('release-pinned CLI image and fallback installs', () => {
  it.each([
    [new CodexAdapter(), '@openai/codex', 'codex', AGENT_CLI_VERSIONS.codex],
    [
      new ClaudeCodeAdapter(),
      '@anthropic-ai/claude-code',
      'claude',
      AGENT_CLI_VERSIONS['claude-code'],
    ],
  ] as const)(
    'pins %s fallback but keeps preinstalled images installation-free',
    async (adapter, name, binary, version) => {
      const plan = adapter.getInstallPlan(image);
      expect(plan).toMatchObject({
        strategy: 'install-on-start',
        packageManagerCmds: [`npm install -g ${name}@${version}`],
      });
      const commands: string[][] = [];
      await adapter.install(async (cmd) => {
        commands.push(cmd);
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      expect(commands).toEqual([['sh', '-c', `npm install -g ${name}@${version}`]]);
      expect(adapter.getInstallPlan({ ...image, supportedRuntimes: [adapter.id] })).toMatchObject({
        strategy: 'preinstalled',
        packageManagerCmds: [],
      });
      const probes: string[][] = [];
      expect(
        await adapter.isInstalled(async (cmd) => {
          probes.push(cmd);
          return {
            stdout: cmd[0] === 'sh' ? `/old/bin/${binary}` : 'old-but-usable-version',
            stderr: '',
            exitCode: 0,
          };
        }),
      ).toBe(true);
      expect(probes).toEqual([
        ['sh', '-c', `command -v ${binary}`],
        [binary, '--version'],
      ]);
    },
  );

  it('keeps both Dockerfile architecture builds on the exact fallback versions', () => {
    for (const tier of ['platform-boxlite', 'platform-sandbox']) {
      const dockerfile = readFileSync(resolve(process.cwd(), `images/${tier}/Dockerfile`), 'utf8');
      expect(/^ARG CODEX_VERSION=(.*)$/m.exec(dockerfile)?.[1]).toBe(AGENT_CLI_VERSIONS.codex);
      expect(/^ARG CLAUDE_CODE_VERSION=(.*)$/m.exec(dockerfile)?.[1]).toBe(
        AGENT_CLI_VERSIONS['claude-code'],
      );
    }
  });
});
