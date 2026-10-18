/** Promise-based repository ports over synchronous SQLite: execute immediately,
 * while reporting a read/decoder failure as a rejection, like an async method. */
export function readSqlite<T>(read: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(read());
  });
}
