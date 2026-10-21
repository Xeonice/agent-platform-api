import { runSandboxProviderContractTests } from '@platform/contracts/testkit';
import { createDockerClient } from '../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-client';
import { AioSandboxProvider } from '../../../packages/modules/sandbox/src/infrastructure/providers/aio/aio-sandbox.provider';
import { BoxliteSandboxProvider } from '../../../packages/modules/sandbox/src/infrastructure/providers/boxlite/boxlite-sandbox.provider';

// Actual built-ins run the public SPI testkit, just like third-party providers.
// Construction and static capability checks do not contact Docker or start a VM.
// Live SP/DP clauses remain visibly skipped: this fixture supplies no live context.
const staticOptions = {
  expectedCapabilities: {
    spawnTty: true,
    volumeMount: true,
    updateResources: false,
    pauseResume: false,
    snapshot: false,
    watchEvents: false,
    headlessTask: true,
  },
  skipLiveReason: 'host-free Golden fixture; no sandbox is created',
  skipDataPlaneReason: 'real Guest/CLI continuity belongs to separate native acceptance',
};

runSandboxProviderContractTests(
  'aio (built-in, real implementation)',
  () => new AioSandboxProvider(createDockerClient()),
  staticOptions,
);

runSandboxProviderContractTests(
  'boxlite (built-in, real implementation)',
  () => new BoxliteSandboxProvider(),
  staticOptions,
);
