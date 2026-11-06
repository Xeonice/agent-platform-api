/** Trusted framework prototypes only; never use this for serialized/unknown input.
 * Object.create preserves the supplied Express prototype while lib.d.ts erases
 * that relationship to any. Callers still initialize their own request state. */
export function prototypeClone<T extends object>(prototype: T): T {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Object.create's stdlib any loses the supplied trusted framework prototype type; this shim preserves that inheritance relationship only.
  return Object.create(prototype) as T;
}
