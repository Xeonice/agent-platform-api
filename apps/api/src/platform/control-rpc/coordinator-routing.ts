import { z } from 'zod';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { SystemClock } from '../time/system-clock';
export interface CoordinatorBinding {
  instanceId: string;
  state: 'ready' | 'quiescing';
  origin: string;
  generation: number;
  artifactDigest: string;
}
const CoordinatorBindingSchema = z.object({
  instanceId: z.string(),
  state: z.enum(['ready', 'quiescing']),
  origin: z.string(),
  generation: z.number().int().positive(),
  artifactDigest: z.string(),
});
export function createCoordinatorResolver(
  initial: URL,
  instanceId: string,
  path = process.env.PLATFORM_COORDINATOR_BINDING_PATH,
): (logicalDeadline?: number) => Promise<URL> {
  const clock = new SystemClock();
  if (path && !isAbsolute(path)) throw new Error('COORDINATOR_BINDING_PATH_MUST_BE_ABSOLUTE');
  return async (logicalDeadline) => {
    if (!path) return initial;
    const deadline = Math.min(clock.now().getTime() + 1750, logicalDeadline ?? Infinity);
    for (;;) {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0)
        throw new Error('UNTRUSTED_COORDINATOR_BINDING');
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!value || typeof value !== 'object') throw new Error('INVALID_COORDINATOR_BINDING');
      const binding = CoordinatorBindingSchema.parse(value),
        target = new URL(binding.origin);
      if (
        binding.instanceId !== instanceId ||
        !Number.isSafeInteger(binding.generation) ||
        binding.generation < 1 ||
        target.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
        target.username ||
        target.password ||
        target.pathname !== '/' ||
        target.hash ||
        target.search ||
        !/^sha256:[a-f0-9]{64}$/.test(binding.artifactDigest)
      )
        throw new Error('INVALID_COORDINATOR_BINDING');
      if (binding.state === 'ready') return target;
      if (clock.now().getTime() >= deadline) throw new Error('COORDINATOR_HANDOFF_BUDGET_EXCEEDED');
      // No application command has been dispatched while waiting here.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  };
}
