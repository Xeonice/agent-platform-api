/** Fails on any dependency access outside the scenario's explicit scope. */
export function unused<T extends object>(label: string): T {
  return new Proxy({} as T, {
    get: (_target, key) => {
      throw new Error(`${label}.${String(key)} is outside this scenario`);
    },
  });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function useEnv(patch: Record<string, string | undefined>): () => void {
  const prior = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(patch);
  return () => apply(prior);
}
