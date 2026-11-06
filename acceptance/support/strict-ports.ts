/** Fails on any dependency access outside the scenario's explicit scope. */
export function unused<T extends object>(label: string): T {
  const proxy = new Proxy(
    {},
    {
      get: (_target, key) => {
        throw new Error(`${label}.${String(key)} is outside this scenario`);
      },
    },
  );
  return proxy as T;
}

/** Partial test port whose unprovided members fail instead of masquerading as an implementation. */
export function stub<T extends object>(members: Partial<T>, label = 'fixture port'): T {
  const proxy = new Proxy(members, {
    get(target, key, receiver) {
      if (!Object.hasOwn(target, key))
        throw new Error(`${label}.${String(key)} is outside this scenario`);
      return Reflect.get(target, key, receiver);
    },
  });
  return proxy as T;
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
