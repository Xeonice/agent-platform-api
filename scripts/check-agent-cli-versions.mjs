#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(
  resolve(root, 'packages/modules/runtime/src/infrastructure/adapters/agent-cli-versions.ts'),
  'utf8',
);
const pins = {
  CODEX_VERSION: /codex:\s*'([^']+)'/.exec(source)?.[1],
  CLAUDE_CODE_VERSION: /'claude-code':\s*'([^']+)'/.exec(source)?.[1],
};
for (const [name, version] of Object.entries(pins)) {
  if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error(`${name} fallback must pin one stable version`);
  for (const tier of ['platform-boxlite', 'platform-sandbox']) {
    const dockerfile = readFileSync(resolve(root, `images/${tier}/Dockerfile`), 'utf8');
    const actual = new RegExp(`^ARG ${name}=([^\\s]+)\\s*$`, 'm').exec(dockerfile)?.[1];
    if (actual !== version)
      throw new Error(`${tier} ${name} ${actual ?? '(missing)'} differs from fallback ${version}`);
  }
}
console.log('Agent CLI image and fallback versions agree:', JSON.stringify(pins));
