import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2).filter((argument) => argument !== '--');
const projects = args.flatMap((argument, index) =>
  argument === '--project' && args[index + 1] ? [args[index + 1]] : [],
);
const cpuCap = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
function run(arguments_, cap) {
  const requested = Number(process.env.VITEST_MAX_FORKS);
  const maximum = Number.isInteger(requested) && requested > 0 ? Math.min(cap, requested) : cap;
  return new Promise((resolve) => {
    const child = spawn('vitest', arguments_, {
      stdio: 'inherit',
      env: { ...process.env, VITEST_MIN_FORKS: '1', VITEST_MAX_FORKS: String(maximum) },
    });
    child.on('error', (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) console.error(`Vitest terminated by ${signal}`);
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}
// Owner protocol acceptance launches the production role in a real child process.
// Build that child's local dependency graph first, including on a fresh checkout;
// otherwise a passing source-level test could silently exercise stale dist bytes.
async function runProtocol(arguments_) {
  const built = await new Promise((resolve) => {
    const child = spawn(process.execPath, [require.resolve('typescript/bin/tsc'), '-b'], {
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) console.error(`Protocol build terminated by ${signal}`);
      resolve(signal ? 1 : (code ?? 1));
    });
  });
  return built === 0 ? run(arguments_, 1) : built;
}
let status;
if (projects.length === 0) {
  const rest = args.filter((argument) => argument !== 'run');
  status = await run(
    ['run', '--project', 'pure', '--project', 'service', '--project', 'sqlite', ...rest],
    cpuCap,
  );
  if (status === 0) status = await runProtocol(['run', '--project', 'protocol', ...rest]);
} else status = await (projects.includes('protocol') ? runProtocol(args) : run(args, cpuCap));
process.exit(status);
