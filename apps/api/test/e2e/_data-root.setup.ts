import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Point DATA_ROOT at a throwaway directory for EVERY e2e file.
 *
 * WHY THIS IS A SETUP FILE AND NOT A `beforeAll` IN EACH SPEC: `LoggingModule` is
 * assembled globally in `AppModule`, and `RuntimeLogWriter` opens its stream in the
 * DI constructor — synchronously, unconditionally, whether or not the spec cares
 * about logging. So the moment a spec does `Test.createTestingModule({imports:[AppModule]})`
 * it touches `${DATA_ROOT}/logs/` on a real disk. 13 e2e specs import AppModule;
 * only a handful set DATA_ROOT themselves. The default is `resolve(cwd, 'data')`
 * — **the same path the local dev server uses**.
 *
 * Two processes writing one `runtime.log` is not a cosmetic problem: each keeps its
 * own in-memory `size` counter, so when one rotates (`rename` runtime.log → .1) the
 * other's stream keeps writing into the RENAMED file and `runtime.log` disappears.
 * That is the exact failure `runtime-log-writer.ts` documents and regression-tests
 * against — this just moves it from intra-process to cross-process, where the
 * writer has no protection at all (no file lock, not even detection).
 *
 * Fixing it per-spec would leave the next new e2e file to rediscover it, so the
 * default is made safe here instead. A spec that wants its own root still wins:
 * setup files run BEFORE `beforeAll`.
 */
const root = mkdtempSync(join(tmpdir(), 'api-e2e-data-'));
process.env.DATA_ROOT = root;

process.on('exit', () => {
  rmSync(root, { recursive: true, force: true });
});
