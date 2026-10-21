import 'reflect-metadata';
import { startRuntimeOwnerApplication } from './runtime-owner-application';

async function main(): Promise<void> {
  process.env.PLATFORM_PROCESS_ROLE = 'runtime-owner';
  const owner = await startRuntimeOwnerApplication();
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
