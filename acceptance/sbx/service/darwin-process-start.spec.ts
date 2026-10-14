import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDarwinProcessStart } from '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/darwin-process-start';
import { boxliteShimIdentity } from '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-shim-identity';

describe.skipIf(process.platform !== 'darwin')('real Darwin libproc process evidence', () => {
  it('verifies an actual live child, rejects changed birth and rejects it after exit', async () => {
    const child = spawn('/bin/sleep', ['30']);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const home = await mkdtemp(join(tmpdir(), 'boxlite-darwin-identity-'));
    const record = join(home, 'shim.pid');
    try {
      const pid = child.pid;
      expect(pid).toBeTypeOf('number');
      if (pid === undefined) throw new Error('Child has no PID');
      const first = await readDarwinProcessStart(pid);
      expect(first).not.toBeNull();
      if (!first) throw new Error('libproc did not observe the live child');
      expect(await readDarwinProcessStart(pid)).toEqual(first);
      const io = {
        platform: 'darwin' as const,
        home: () => home,
        readFile: async () => (await import('node:fs/promises')).readFile(record, 'utf8'),
        darwinProcessStart: readDarwinProcessStart,
      };
      await writeFile(record, `${pid}\n${first.startTime}\n`);
      expect(await boxliteShimIdentity('real-child', io)).toBe(
        `boxlite:real-child:shim:${pid}:${first.startTime}`,
      );
      await writeFile(record, `${pid}\n${String(BigInt(first.startTime) + 1n)}\n`);
      expect(await boxliteShimIdentity('real-child', io)).toBeNull();
      child.kill('SIGTERM');
      await exited;
      expect(await readDarwinProcessStart(pid)).toBeNull();
      await writeFile(record, `${pid}\n${first.startTime}\n`);
      expect(await boxliteShimIdentity('real-child', io)).toBeNull();
    } finally {
      child.kill('SIGTERM');
      await exited;
      await rm(home, { recursive: true, force: true });
    }
  });
});
