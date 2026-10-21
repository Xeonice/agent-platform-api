import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  RuntimeOwnerPlacementSchema,
} from '@platform/contracts';
import type { PlatformReservation, RuntimeOwnerSchedulingSnapshot } from '@platform/contracts';
import type { ResourceAllocation } from '../domain/entities/resource-allocation.entity';

export function unavailableOwnerCapacity(reason: string): never {
  throw new SandboxProviderError(
    SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
    `Owner capacity unavailable: ${reason}`,
    undefined,
    true,
  );
}

/** A planned route is not a runtime handle or a claim that a Guest exists. */
export function pendingOwnerPlacement(state: Record<string, unknown> | null): string | undefined {
  if (!state || !Object.hasOwn(state, 'runtimeOwnerPlacement')) return undefined;
  const parsed = RuntimeOwnerPlacementSchema.safeParse(state.runtimeOwnerPlacement);
  if (!parsed.success) return unavailableOwnerCapacity('pending Owner placement is malformed');
  return parsed.data.ownerId;
}

export function sandboxOwnerEvidence(sandbox: {
  id: string;
  providerState: Record<string, unknown> | null;
  providerSandboxId: string | null;
}): string | null | undefined {
  const planned = pendingOwnerPlacement(sandbox.providerState);
  if (sandbox.providerSandboxId === null) return planned;
  const reference = sandbox.providerState?.runtimeOwner;
  const actual =
    typeof reference === 'object' &&
    reference !== null &&
    'ownerId' in reference &&
    typeof reference.ownerId === 'string' &&
    'sandboxId' in reference &&
    reference.sandboxId === sandbox.id
      ? reference.ownerId
      : null;
  if (planned && planned !== actual)
    return unavailableOwnerCapacity('actual handle conflicts with pending placement');
  return actual;
}

/** Classification does not rewrite legacy rows or invent quotas for Owner-only reservations. */
export function ownerResourcePool(
  observation: RuntimeOwnerSchedulingSnapshot,
  active: readonly ResourceAllocation[],
  handles: ReadonlyMap<string, string | null>,
  reservations: readonly PlatformReservation[],
) {
  const installed = new Set(observation.ownerIds);
  if (!installed.has(observation.ownerId) || !installed.has(observation.helperOwnerId))
    return unavailableOwnerCapacity('default/helper Owner is not installed');
  const claims = new Map<string, { ownerId: string; state: 'owned' | 'unconfirmed' }>();
  for (const claim of observation.assignments) {
    if (!installed.has(claim.ownerId) || claims.has(claim.sandboxId))
      return unavailableOwnerCapacity('conflicting Owner assignments');
    claims.set(claim.sandboxId, claim);
  }
  if (!claims.has('auth-helper') && observation.helperOwnerId !== observation.ownerId)
    return unavailableOwnerCapacity('original helper result is unconfirmed');
  const ids = new Set(active.map((row) => String(row.sandboxId)));
  if (ids.size !== active.length) return unavailableOwnerCapacity('duplicate active allocations');
  for (const [id, claim] of claims) {
    if (id === 'auth-helper') {
      if (claim.state !== 'owned' || claim.ownerId !== observation.helperOwnerId)
        return unavailableOwnerCapacity('helper assignment is unconfirmed');
    } else if (!ids.has(id))
      return unavailableOwnerCapacity('Owner assignment has no active quota');
  }
  const selected: ResourceAllocation[] = [];
  for (const row of active) {
    const node = String(row.nodeId);
    const handle = handles.get(String(row.sandboxId));
    const claim = claims.get(String(row.sandboxId))?.ownerId;
    if (node !== 'local') return unavailableOwnerCapacity('unrecognized allocation pool');
    // Null means an actual handle with malformed/unknown ownership, distinct from
    // undefined for a reservation whose provider has not been called yet.
    if (handle === null) return unavailableOwnerCapacity('legacy handle ownership is unknown');
    const candidates = [handle, claim].filter((value): value is string => !!value);
    if (!candidates.length || new Set(candidates).size !== 1 || !installed.has(candidates[0]))
      return unavailableOwnerCapacity('allocation Owner is unknown or conflicting');
    if (candidates[0] === observation.ownerId) selected.push(row);
  }
  const held = reservations.filter((reservation) => {
    if (reservation.owner !== 'auth-helper')
      return unavailableOwnerCapacity('unrecognized platform reservation Owner');
    return observation.helperOwnerId === observation.ownerId;
  });
  return { selected, reservations: held };
}
