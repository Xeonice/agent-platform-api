import { AsyncLocalStorage } from 'node:async_hooks';

// A status response may ask the catalog and repair projection for the same
// physical proof. Reuse only within that response, never across observations.
const observation = new AsyncLocalStorage<Map<object, Map<string, Promise<unknown>>>>();

export function withUpgradeObservation<T>(read: () => Promise<T>): Promise<T> {
  return observation.run(new Map(), read);
}

export function observeUpgradeOnce<T>(
  owner: object,
  key: string,
  read: () => Promise<T>,
  decode: (value: unknown) => T,
): Promise<T> {
  const scope = observation.getStore();
  if (!scope) return read();
  let proofs = scope.get(owner);
  if (!proofs) {
    proofs = new Map();
    scope.set(owner, proofs);
  }
  const prior = proofs.get(key);
  if (prior) return prior.then(decode);
  const proof = read();
  proofs.set(key, proof);
  return proof;
}
