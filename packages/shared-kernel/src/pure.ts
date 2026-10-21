// Domain-safe public surface. IO, process configuration and infrastructure helpers
// remain on the general entry. ESLint checks this entry and its dependency graph.
export * from './types/branded';
export * from './types/value-guards';
export * from './ports/clock.port';
export * from './ports/business-writer-authority.port';
export * from './ports/time.util';
export * from './ports/id-generator.port';
export * from './ports/unit-of-work.port';
export * from './ports/event-bus.port';
export * from './domain/domain-event';
export * from './domain/aggregate-root';
export * from './domain/runtime-secret';
export * from './domain/reserved-env';
export * from './domain/image-alias';
export * from './net/git-remote';
export * from './net/git-platform-registry';
