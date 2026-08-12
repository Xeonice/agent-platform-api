/**
 * DI token for the opaque database handle. The concrete type (a Drizzle
 * better-sqlite3 database) is known only to the infrastructure layer, which
 * casts it. Kept here so both the infrastructure repositories (consumers) and
 * the platform assembly (provider) can agree on a single symbol without an
 * awkward app→module dependency direction.
 */
export const DATABASE = Symbol('Database');
