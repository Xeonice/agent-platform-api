import { createHash } from 'node:crypto';
import { runImageSpecContractTests } from '@platform/contracts/testkit';
import { ImageSpecError, REF_NOT_FOUND } from '@platform/contracts';
import type { ImageSpecManifest } from '@platform/contracts';
import { OciImageSpecProvider } from '../../../packages/modules/image/src/infrastructure/spec/oci-image-spec.provider';
import { OciRegistryClient } from '../../../packages/modules/image/src/infrastructure/spec/oci-registry.client';
import type { FetchedManifest } from '../../../packages/modules/image/src/infrastructure/spec/oci-registry.client';

const GOOD_REF = 'registry.invalid/golden/sandbox:current';
const MISSING_REF = 'registry.invalid/golden/does-not-exist:current';
const EXPECTED_DIGEST = `sha256:${createHash('sha256').update(GOOD_REF).digest('hex')}`;
const DIFF_IDS = [`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`];

// Only the OCI transport is controlled. Resolve/validate and the public contract
// assertions are the actual production implementation; no registry is contacted.
class FixtureRegistryClient extends OciRegistryClient {
  override async fetchManifest(name: string, reference: string): Promise<FetchedManifest> {
    if (name.includes('does-not-exist')) {
      throw new ImageSpecError(REF_NOT_FOUND, `image '${name}:${reference}' not found in fixture`);
    }
    return {
      digest: EXPECTED_DIGEST,
      config: {
        rootfs: { type: 'layers', diff_ids: DIFF_IDS },
        config: {
          WorkingDir: '/workspace',
          Entrypoint: ['/usr/local/bin/entrypoint.sh'],
          Labels: {
            'platform.tmux': 'true',
            'platform.supportedRuntimes': 'codex,claude-code',
            'platform.resourceDefaults': '{"cores":4,"ramMb":4096,"diskMb":20480}',
          },
        },
      },
    };
  }
}

const runtimes = { list: () => [{ id: 'codex' }, { id: 'claude-code' }] };
const clock = { now: () => new Date('2026-10-18T00:00:00Z') };
const compliant: ImageSpecManifest = {
  name: 'registry.invalid/golden/sandbox',
  version: 'current',
  baseImage: 'debian:bookworm',
  entrypointContract: { workdir: '/workspace', entrypoint: ['/usr/local/bin/entrypoint.sh'] },
  supportedRuntimes: ['codex', 'claude-code'],
  resourceDefaults: { cores: 4, ramMb: 4096, diskMb: 20480 },
  labelsRequired: ['platform.tmux'],
  diffIds: DIFF_IDS,
};

runImageSpecContractTests(
  'oci (built-in, real implementation)',
  () => new OciImageSpecProvider(clock, runtimes, new FixtureRegistryClient()),
  {
    ref: GOOD_REF,
    expectedDigest: EXPECTED_DIGEST,
    missingRef: MISSING_REF,
    compliantManifest: compliant,
    // Labels are inherited metadata, not proof of live tmux or image lineage.
    unlabelledManifest: { ...compliant, labelsRequired: [] },
    runtimeNotPreinstalledManifest: { ...compliant, supportedRuntimes: ['codex'] },
    brokenEntrypointManifest: {
      ...compliant,
      entrypointContract: { workdir: '', entrypoint: [] },
    },
  },
);
