import { dirname, resolve } from 'node:path';
import { installedApiIdentity } from '../artifact-identity';

/** The same physical installed-tree verifier is used by both control roles. */
export async function coordinatorArtifactIdentity(): Promise<{
  artifactDigest: string;
  inputFingerprint: string;
  root: string;
} | null> {
  const identity = await installedApiIdentity('coordinator');
  if (!identity) return null;
  process.env.PLATFORM_COORDINATOR_ACTUAL_DIGEST = identity.artifactDigest;
  process.env.PLATFORM_COORDINATOR_ACTUAL_INPUT_FINGERPRINT = identity.inputFingerprint;
  return {
    ...identity,
    root: resolve(dirname(process.argv[1] ?? process.cwd()), '../../../../..'),
  };
}
