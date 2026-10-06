import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

const args = process.argv.slice(2);
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
let status;
if (projects.length === 0) {
  const rest = args.filter((argument) => argument !== 'run');
  status = await run(
    ['run', '--project', 'pure', '--project', 'service', '--project', 'sqlite', ...rest],
    cpuCap,
  );
  if (status === 0) status = await run(['run', '--project', 'protocol', ...rest], 1);
} else status = await run(args, projects.includes('protocol') ? 1 : cpuCap);
process.exit(status);
