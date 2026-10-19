import 'reflect-metadata';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SystemClock } from '../platform/time/system-clock';
import { z } from 'zod';
import { requireUpgrade } from '../platform/upgrade/upgrade-trust';
import { bootstrapIndependentColdBusiness } from '../platform/persistence/cold-business-bootstrap';

const schema = z
  .object({
    instanceId: z.string(),
    businessPath: z.string(),
    controlPath: z.string(),
    migrationsFolder: z.string(),
    coordinatorArtifactRoot: z.string(),
    deadline: z.number().int(),
  })
  .strict();
async function main() {
  const path = process.argv[2];
  requireUpgrade(
    process.env.PLATFORM_PROCESS_ROLE === 'installation-admin' && path && isAbsolute(path),
    'COLD_BOOTSTRAP_ADMIN_CONFIG_REQUIRED',
  );
  const stat = await lstat(path);
  requireUpgrade(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      stat.size <= 16384 &&
      (await realpath(path)) === resolve(path) &&
      (!process.getuid || stat.uid === process.getuid()),
    'COLD_BOOTSTRAP_CONFIG_INSECURE',
  );
  const receipt = await bootstrapIndependentColdBusiness(
    schema.parse(JSON.parse(await readFile(path, 'utf8'))),
    { clock: new SystemClock(), ids: { next: randomUUID } },
  );
  process.stdout.write(JSON.stringify(receipt) + '\n');
}
void main().catch((error: unknown) => {
  const code =
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{1,100}$/.test(error.code)
      ? error.code
      : 'COLD_BOOTSTRAP_FAILED';
  process.stderr.write(code + '\n');
  process.exitCode = 1;
});
