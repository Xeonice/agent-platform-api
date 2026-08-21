import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ProviderDto } from '@platform/contracts';
import { SandboxApplicationService } from '../../application/sandbox-application.service';
import { ProviderResponseDto } from './dto/sandbox.dto';

/**
 * `GET /api/providers` — capability discovery (docs/backend/04 §5 「能力发现」).
 *
 * A thin read-only shell over the provider registry: no business logic, no persistence.
 * The response is REGISTRY-DRIVEN, so a provider registered by an out-of-tree module
 * (04 §8 方式一) shows up here without touching this file, and the frontend can drive
 * both its provider picker and its per-capability controls (no `pauseResume` ⇒ no
 * "暂停" button) off the wire instead of a hard-coded list.
 *
 * Not registered as an MCP tool: capability discovery is UI plumbing, and an agent
 * caller has no decision to make with it.
 */
@ApiTags('sandbox')
@Controller('providers')
export class ProviderController {
  constructor(private readonly app: SandboxApplicationService) {}

  @Get()
  @ApiOperation({ summary: 'List registered sandbox providers with their capabilities' })
  @ApiOkResponse({ type: ProviderResponseDto, isArray: true })
  list(): ProviderDto[] {
    return this.app.listProviders();
  }
}
