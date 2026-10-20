import { Inject, Injectable } from '@nestjs/common';
import { RUNTIME_OWNER_SCHEDULING, type RuntimeOwnerScheduling } from '@platform/contracts';
import type { HostCapacityProbe } from '../../domain/ports/host-capacity.port';

@Injectable()
export class RuntimeOwnerCapacityProbe implements HostCapacityProbe {
  constructor(@Inject(RUNTIME_OWNER_SCHEDULING) private readonly owners: RuntimeOwnerScheduling) {}
  async capacity() {
    return (await this.owners.snapshot()).capacity;
  }
}
