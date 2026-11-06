import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = ['openapi.json'];
const watched = ['openapi.json'];

function execute(command, args, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) accept(output);
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`));
    });
  });
}
const git = (args) => execute('git', args, true);
function pnpm(script) {
  // Corepack/pnpm propagates its actual CLI to package scripts, including CI.
  const cli = process.env.npm_execpath;
  return cli ? execute(process.execPath, [cli, 'run', script]) : execute('pnpm', ['run', script]);
}

async function check() {
  const head = (await git(['rev-parse', '--verify', 'HEAD'])).trim();
  for (const path of required) {
    if (!(await lstat(resolve(root, path)).catch(() => null))?.isFile())
      throw new Error(`Required generated file is missing or not regular: ${path}`);
    try {
      await git(['ls-files', '--error-unmatch', '--', path]);
      await git(['cat-file', '-e', `${head}:${path}`]);
    } catch {
      throw new Error(`Required generated file must be tracked in HEAD: ${path}`);
    }
  }
  // emit-openapi reads dist: always rebuild before emitting.
  await pnpm('build');
  await pnpm('openapi:emit');
  if ((await git(['rev-parse', '--verify', 'HEAD'])).trim() !== head)
    throw new Error('HEAD changed during generated-contract validation');
  const [working, staged, untracked] = await Promise.all([
    git(['diff', '--name-only', '--no-ext-diff', head, '--', ...watched]),
    git(['diff', '--cached', '--name-only', '--no-ext-diff', head, '--', ...watched]),
    // Ignored generated files are also absent from HEAD and cannot hide drift.
    git(['ls-files', '--others', '-z', '--', ...watched]),
  ]);
  const changed = [
    ...new Set([
      ...working.trim().split('\n').filter(Boolean),
      ...staged.trim().split('\n').filter(Boolean),
      ...untracked.split('\0').filter(Boolean),
    ]),
  ];
  if (changed.length)
    throw new Error(`Generated contracts differ from HEAD or are untracked: ${changed.join(', ')}`);
  console.log('Generated contracts match HEAD.');
}

check().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
