import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** System endpoints module (health, and later diagnostics / access-passcode). */
@Module({
  controllers: [HealthController],
})
export class SystemModule {}
