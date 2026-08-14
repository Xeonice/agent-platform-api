import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { SandboxDto } from '@platform/contracts';
import { SandboxApplicationService } from '../../application/sandbox-application.service';
import {
  CreateSandboxDto,
  DestroySandboxDto,
  ListSandboxesQueryDto,
  SandboxResponseDto,
} from './dto/sandbox.dto';

/**
 * REST protocol shell (02 §5.1). Thin adapter: it injects the SAME
 * SandboxApplicationService that the MCP tools inject, and does no business logic.
 * All paths carry the global `/api` prefix set at bootstrap.
 *
 * Return types are the real application-service types (SandboxDto); the
 * `@ApiCreatedResponse`/`@ApiOkResponse({ type: SandboxResponseDto })` decorators
 * drive Swagger to reflect the RESPONSE schema into openapi.json (P1-2) — no
 * `as Promise<…>` casts (P2-2).
 */
@ApiTags('sandbox')
@Controller('sandboxes')
export class SandboxController {
  constructor(private readonly app: SandboxApplicationService) {}

  @Post()
  @ApiOperation({ summary: 'Create a sandbox (Task)' })
  @ApiCreatedResponse({ type: SandboxResponseDto })
  create(@Body() dto: CreateSandboxDto): Promise<SandboxDto> {
    return this.app.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List sandboxes, optionally filtered by projectId' })
  @ApiOkResponse({ type: SandboxResponseDto, isArray: true })
  list(@Query() query: ListSandboxesQueryDto): Promise<SandboxDto[]> {
    return this.app.list(query.projectId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a sandbox by id' })
  @ApiOkResponse({ type: SandboxResponseDto })
  get(@Param('id') id: string): Promise<SandboxDto> {
    return this.app.get(id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Destroy a sandbox (optionally keeping its workspace)' })
  @ApiNoContentResponse()
  destroy(@Param('id') id: string, @Body() body: DestroySandboxDto): Promise<void> {
    return this.app.destroy(id, body ?? {});
  }
}
