import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { HealthDtoSchema, type HealthDto } from '@platform/contracts';

export class HealthResponseDto extends createZodDto(HealthDtoSchema) {}

/**
 * System health endpoint (23 D-11/D-12: system endpoints belong to no context).
 * GET /api/health is the ONLY passcode-exempt endpoint (shared/11 §3.1).
 * Uses the Clock port — no direct `Date.now()` (01 §3).
 */
@ApiTags('system')
@Controller('health')
export class HealthController {
  private readonly startedAt: number;

  constructor(@Inject(CLOCK) private readonly clock: Clock) {
    this.startedAt = clock.now().getTime();
  }

  @Get()
  @ApiOperation({ summary: 'Liveness probe (passcode-exempt)' })
  health(): HealthDto {
    return {
      status: 'ok',
      uptimeSec: Math.floor((this.clock.now().getTime() - this.startedAt) / 1000),
    };
  }
}
