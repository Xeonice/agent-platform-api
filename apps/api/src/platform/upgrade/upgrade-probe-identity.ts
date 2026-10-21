/** Noncredential identity of the actual ControlAPI that served a probe. */
export const UPGRADE_PROBE_IDENTITY_HEADERS = {
  instanceId: 'x-platform-probe-instance',
  artifactDigest: 'x-platform-probe-api-digest',
  startIdentity: 'x-platform-probe-api-start',
} as const;

export interface UpgradeProbeApiIdentity {
  instanceId: string;
  artifactDigest: string;
  startIdentity: string;
}

export function matchesProbeIdentity(headers: Headers, identity: UpgradeProbeApiIdentity): boolean {
  const fields: readonly (keyof UpgradeProbeApiIdentity)[] = [
    'instanceId',
    'artifactDigest',
    'startIdentity',
  ];
  return fields.every((key) => headers.get(UPGRADE_PROBE_IDENTITY_HEADERS[key]) === identity[key]);
}

export function hasProbeIdentity(headers: Headers): boolean {
  return Object.values(UPGRADE_PROBE_IDENTITY_HEADERS).some((name) => headers.has(name));
}
