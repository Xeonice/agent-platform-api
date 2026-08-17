import type { DomainEvent, ProjectId } from '@platform/shared-kernel';

/**
 * Project domain events (23 §12). S2 raises `ProjectCreated`; clone PROGRESS is a
 * transient projection pushed straight to the /events gateway (§7.4 §78, not via
 * the outbox), so it is NOT a domain event.
 */
export class ProjectCreated implements DomainEvent {
  readonly type = 'ProjectCreated';
  constructor(
    readonly projectId: ProjectId,
    readonly occurredAt: Date,
  ) {}
}
