import { Injectable } from '@nestjs/common';
import type { Clock } from '@platform/shared-kernel';

/**
 * Clock port implementation — the ONE sanctioned place `new Date()` is allowed
 * (eslint no-restricted-syntax is disabled for this folder; 01 §3 "端口实现处豁免").
 */
@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
