import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/** Every complete Nest app gets a new data directory before its modules are imported. */
const saved = { ...process.env };
const root = mkdtempSync(join(tmpdir(), 'design-v2-protocol-'));
process.env.DATA_ROOT = root;
process.env.ACCESS_PASSCODE_AUTO_GENERATE = 'false';
process.env.SCHEDULER_HOST_CORES = '4096';
process.env.SCHEDULER_HOST_RAM_MB = '4194304';
afterAll(() => {
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});
