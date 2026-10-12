import 'reflect-metadata';
import { startRuntimeOwnerFromEnvironment } from '@platform/sandbox';
import { SystemClock } from '../platform/time/system-clock';

async function main(): Promise<void> {
  process.env.PLATFORM_PROCESS_ROLE = 'runtime-owner';
  const owner = await startRuntimeOwnerFromEnvironment(new SystemClock());
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void owner.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  process.stdout.write('RuntimeOwner ready (authenticated loopback RPC, no business database)\n');
}
void main().catch(() => {
  process.stderr.write('RuntimeOwner startup failed; original resources are not stopped\n');
  process.exitCode = 1;
});
