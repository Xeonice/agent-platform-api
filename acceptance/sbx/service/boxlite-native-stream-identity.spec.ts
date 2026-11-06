import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxliteSandboxProvider } from '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-sandbox.provider';
import type { BoxliteExecution } from '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-runtime';
import { readDarwinProcessStart } from '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/darwin-process-start';

const sdk = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock(
  '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-runtime',
  async (original) => ({
    ...(await original<object>()),
    getSharedBoxliteRuntime: async () => ({
      get: async () => ({
        info: () => ({ state: { running: true }, name: 'native-task-fixture' }),
        exec: sdk.exec,
      }),
    }),
  }),
);
afterEach(() => vi.unstubAllEnvs());

// The SDK execution boundary is external here. Kernel PID/start evidence, the
// real provider, native ProcessStream and absence of lifecycle effects are real.
describe.skipIf(!['darwin', 'linux'].includes(process.platform))(
  'mono native stream identity propagation',
  () => {
    it.each([true, false])(
      'captures the physical incarnation after SDK exec for tty=%s',
      async (tty) => {
        const child = spawn('/bin/sleep', ['30']);
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        const home = await mkdtemp(join(tmpdir(), 'boxlite-stream-identity-'));
        const boxId = 'physical-stream-fixture';
        const pidPath = join(home, 'boxes', boxId, 'shim.pid');
        const signal = vi.fn(async () => undefined);
        const execution: BoxliteExecution = {
          id: async () => 'sdk-execution-fixture',
          stdout: async () => ({ next: async () => null }),
          stderr: async () => ({ next: async () => null }),
          stdin: async () => ({
            write: async () => undefined,
            writeString: async () => undefined,
            close: async () => undefined,
          }),
          wait: async () => ({ exitCode: 0 }),
          kill: vi.fn(async () => undefined),
          signal,
          resizeTty: vi.fn(async () => undefined),
        };
        try {
          const pid = child.pid;
          if (!pid) throw new Error('No child PID');
          const birth =
            process.platform === 'darwin'
              ? (await readDarwinProcessStart(pid))?.startTime
              : (await readFile(`/proc/${pid}/stat`, 'utf8'))
                  .split(')')[1]
                  ?.trim()
                  .split(/\s+/)[19];
          if (!birth) throw new Error('Kernel start evidence unavailable');
          await mkdir(join(home, 'boxes', boxId), { recursive: true });
          await writeFile(pidPath, `${pid}\n${String(BigInt(birth) + 1n)}\n`);
          vi.stubEnv('BOXLITE_HOME', home);
          sdk.exec.mockImplementation(async () => {
            // Model an SDK operation completing before its physical record becomes observable.
            await writeFile(pidPath, `${pid}\n${birth}\n`);
            return execution;
          });
          const provider = new BoxliteSandboxProvider();
          const stream = await provider.spawn(
            { provider: 'boxlite', providerSandboxId: boxId },
            { cmd: ['/bin/sh'], tty },
          );
          expect(stream.runtimeIdentity).toBe(`boxlite:${boxId}:shim:${pid}:${birth}`);
          expect(stream.ref).toBe(tty ? 'boxlite-pty' : 'boxlite-exec');
          expect(sdk.exec).toHaveBeenCalled();
          stream.detach();
          expect(signal).not.toHaveBeenCalled();
          expect(execution.kill).not.toHaveBeenCalled();
          sdk.exec.mockResolvedValue(execution);
          await writeFile(pidPath, `${pid}\n${String(BigInt(birth) + 1n)}\n`);
          const unconfirmed = await provider.spawn(
            { provider: 'boxlite', providerSandboxId: boxId },
            { cmd: ['/bin/sh'], tty },
          );
          expect(unconfirmed.runtimeIdentity).toBeNull();
          unconfirmed.detach();
        } finally {
          child.kill('SIGTERM');
          await exited;
          await rm(home, { recursive: true, force: true });
        }
      },
    );
  },
);
