import { createRequire } from 'node:module';
import { join } from 'node:path';
import { appendFileSync, readFileSync } from 'node:fs';

// Trusted installation composition, not a plugin-path loader. Only the external
// resource implementation is a fixture; Owner DI, HTTP, journal and leases are real.
const apiRoot = process.argv[2];
const require = createRequire(join(apiRoot, 'apps/api/package.json'));
require('reflect-metadata');
const { Module, Injectable, Inject } = require('@nestjs/common');
const { SANDBOX_PROVIDER_REGISTRY } = require('@platform/contracts');
const { RuntimeOwnerApplicationModule, startRuntimeOwnerApplication } = require(
  join(apiRoot, 'apps/api/dist/roles/runtime-owner-application.js'),
);

class InstallationProvider {
  name = 'installation-provider';
  capabilities = {
    spawnTty: false,
    volumeMount: true,
    updateResources: false,
    pauseResume: false,
    snapshot: false,
    watchEvents: false,
    headlessTask: false,
  };
  resources = new Map();
  constructor() {
    if (process.env.PLATFORM_PROCESS_ROLE !== 'runtime-owner')
      throw Error('Fixture SDK constructor executed outside Owner');
    appendFileSync(
      join(process.env.RUNTIME_OWNER_HOME, 'provider-constructions.jsonl'),
      JSON.stringify({ pid: process.pid, role: process.env.PLATFORM_PROCESS_ROLE }) + '\n',
    );
  }
  async create(context) {
    const providerSandboxId = `${process.env.RUNTIME_OWNER_ID}:${context.sandboxId}`;
    this.resources.set(providerSandboxId, 'instance_creating');
    return { provider: this.name, providerSandboxId, providerState: { fixturePid: process.pid } };
  }
  async start(handle) {
    this.resources.set(handle.providerSandboxId, 'instance_running');
  }
  async stop(handle) {
    this.resources.set(handle.providerSandboxId, 'instance_exited');
  }
  async destroy(handle) {
    this.resources.delete(handle.providerSandboxId);
  }
  async inspect(handle) {
    return {
      lifecycleState: this.resources.get(handle.providerSandboxId) ?? 'instance_not_found',
      raw: { fixturePid: process.pid, ownerId: process.env.RUNTIME_OWNER_ID },
    };
  }
  async spawn() {
    throw Error('This resource fixture declares no TTY capability');
  }
}
Injectable()(InstallationProvider);

class InstallationRegistration {
  constructor(registry, provider) {
    this.registry = registry;
    this.provider = provider;
  }
  async onModuleInit() {
    // A genuine async hook must finish before the public Owner metadata exists.
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (process.env.OWNER_FIXTURE_CASE === 'duplicate') this.provider.name = 'aio';
    this.registry.register(this.provider, { default: true });
    if (process.env.OWNER_FIXTURE_CASE === 'hook-failure') throw Error('installation init failed');
  }
  async onModuleDestroy() {
    // Cleanup must retain the same lock until every hook has finished.
    const lockPath = join(process.env.RUNTIME_OWNER_HOME, 'owner-process.lock');
    const before = readFileSync(lockPath, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (readFileSync(lockPath, 'utf8') !== before || JSON.parse(before).pid !== process.pid)
      throw Error('Owner lock was released before the plugin shutdown hook finished');
    appendFileSync(
      join(process.env.RUNTIME_OWNER_HOME, 'context-closed.jsonl'),
      JSON.stringify({ pid: process.pid, heldLockThroughShutdown: true }) + '\n',
    );
  }
}
Injectable()(InstallationRegistration);
Inject(SANDBOX_PROVIDER_REGISTRY)(InstallationRegistration, undefined, 0);
Inject(InstallationProvider)(InstallationRegistration, undefined, 1);
class InstallationExtensionModule {}
Module({ providers: [InstallationProvider, InstallationRegistration] })(
  InstallationExtensionModule,
);
class InstallationOwnerModule {}
Module({ imports: [RuntimeOwnerApplicationModule, InstallationExtensionModule] })(
  InstallationOwnerModule,
);

try {
  const owner = await startRuntimeOwnerApplication(InstallationOwnerModule);
  const address = owner.server.server.address();
  process.stdout.write(
    'OWNER_READY:' +
      JSON.stringify({
        endpoint: `http://127.0.0.1:${address.port}`,
        pid: process.pid,
      }) +
      '\n',
  );
  const close = () =>
    void Promise.all([owner.close(), owner.close()]).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
} catch (error) {
  process.stdout.write('OWNER_REJECTED:' + JSON.stringify({ message: error.message }) + '\n');
  process.exitCode = 1;
}
