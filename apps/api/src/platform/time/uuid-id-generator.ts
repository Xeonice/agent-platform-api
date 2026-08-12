import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { IdGenerator } from '@platform/shared-kernel';

/**
 * IdGenerator port implementation — the ONE sanctioned place `randomUUID()` is
 * allowed (eslint no-restricted-syntax is disabled for this folder).
 */
@Injectable()
export class UuidIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
