import type { GitPlatform } from './obtained-via.vo';

/**
 * Non-sensitive git credential metadata (docs/backend/23 §8.3, 13 §2.5.1). The
 * host public keys recorded here are NOT secrets and are stored/returned in the
 * clear (03 §7.3 H — `known_hosts` pinning + display). `firstSeenAt` is kept as an
 * ISO string (it lives inside a JSON blob, never a first-class timestamp column).
 */
export interface KnownHostEntry {
  host: string;
  keyType: string;
  fingerprint: string;
  firstSeenAt: string;
}

export interface CredentialMetadata {
  provider?: GitPlatform;
  knownHosts?: KnownHostEntry[];
}
