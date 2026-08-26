import { createHash } from 'node:crypto';
import { runImageSpecContractTests } from '@platform/contracts/testkit';
import { ImageSpecError, REF_NOT_FOUND } from '@platform/contracts';
import type { ImageSpecManifest } from '@platform/contracts';
import { OciImageSpecProvider } from '../../src/infrastructure/spec/oci-image-spec.provider';
import { OciRegistryClient } from '../../src/infrastructure/spec/oci-registry.client';
import type { FetchedManifest } from '../../src/infrastructure/spec/oci-registry.client';

/**
 * The golden `ImageSpecProvider` suite (04 §10.4 IS-01..IS-05) run against the
 * BUILT-IN provider — the same suite a third-party implementation runs, no double
 * standard (04 §10).
 *
 * The registry is a fixture, not a network: IS-01..IS-05 are about the CONTRACT
 * (a real digest, a typed not-found, a locatable error, purity, tmux), none of which
 * needs a reachable host. The wire behaviour of the client itself — Accept headers,
 * digest verification, the token dance — is pinned separately in
 * `test/unit/oci-registry.client.spec.ts`.
 */
const GOOD_REF = 'ghcr.io/agent-infra/sandbox:latest';
const MISSING_REF = 'ghcr.io/agent-infra/does-not-exist:latest';
const EXPECTED_DIGEST = `sha256:${createHash('sha256').update(GOOD_REF).digest('hex')}`;
const BASE_DIFF_IDS = [`sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`];

class FixtureRegistryClient extends OciRegistryClient {
  override async fetchManifest(name: string, reference: string): Promise<FetchedManifest> {
    if (name.includes('does-not-exist')) {
      throw new ImageSpecError(REF_NOT_FOUND, `image '${name}:${reference}' not found in registry`);
    }
    return {
      digest: EXPECTED_DIGEST,
      config: {
        /**
         * ⚠️ THE LINEAGE ANCHOR ARRIVES IN THE SAME BLOB AS `Labels`, AND THAT IS WHY
         * IT IS FREE. Measured against a real registry: a platform base image resolved
         * to 77 `diff_ids` and an image built `FROM` it to 78, with the first 77
         * identical — no layer was ever downloaded to learn that (04 §7 ★血统).
         */
        rootfs: { type: 'layers', diff_ids: BASE_DIFF_IDS },
        config: {
          WorkingDir: '/home/gem',
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

/**
 * Two runtimes registered, mirroring the real platform (codex + claude-code).
 * The provider only reads the IDS, so this is the whole dependency — no adapters.
 */
const runtimeRegistry = { list: () => [{ id: 'codex' }, { id: 'claude-code' }] };

const clock = { now: () => new Date('2026-08-25T10:00:00.000Z') };

const compliant: ImageSpecManifest = {
  name: 'ghcr.io/agent-infra/sandbox',
  version: 'latest',
  baseImage: 'debian:bookworm',
  entrypointContract: { workdir: '/home/gem', entrypoint: ['/usr/local/bin/entrypoint.sh'] },
  supportedRuntimes: ['codex', 'claude-code'],
  resourceDefaults: { cores: 4, ramMb: 4096, diskMb: 20480 },
  labelsRequired: ['platform.tmux'],
  diffIds: BASE_DIFF_IDS,
};

runImageSpecContractTests(
  'oci (built-in)',
  () => new OciImageSpecProvider(clock, runtimeRegistry, new FixtureRegistryClient()),
  {
    ref: GOOD_REF,
    expectedDigest: EXPECTED_DIGEST,
    missingRef: MISSING_REF,
    compliantManifest: compliant,
    // ⚠️ THE SAME FIXTURE, THE OPPOSITE EXPECTATION (see IS-05 in the testkit). An
    // image carrying no `platform.*` label at all is a perfectly VALID spec: labels are
    // inherited, so on any derived image they describe an ancestor rather than the
    // image in hand. Compliance is decided by lineage at registration and by
    // `command -v tmux` at runtime — neither of which `validate()` can see.
    unlabelledManifest: { ...compliant, labelsRequired: [] },
    // tmux declared, but `claude-code` is not among the preinstalled runtimes ⇒ a
    // WARNING (still selectable), never an error: 现装 works, it just costs minutes.
    runtimeNotPreinstalledManifest: { ...compliant, supportedRuntimes: ['codex'] },
    brokenEntrypointManifest: {
      ...compliant,
      entrypointContract: { workdir: '', entrypoint: [] },
    },
  },
);
