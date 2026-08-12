import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SandboxApplicationService } from '../../application/sandbox-application.service';
import { CreateSandboxDto, ListSandboxesQueryDto, SandboxResponseDto } from './dto/sandbox.dto';

/**
 * REST protocol shell (02 §5.1). It is a thin adapter: it injects the SAME
 * SandboxApplicationService that the MCP tools inject, and does no business logic.
 * All paths carry the global `/api` prefix set at bootstrap.
 */
@ApiTags('sandbox')
@Controller('sandboxes')
export class SandboxController {
  constructor(private readonly app: SandboxApplicationService) {}

  @Post()
  @ApiOperation({ summary: 'Create a sandbox (Task)' })
  create(@Body() dto: CreateSandboxDto): Promise<SandboxResponseDto> {
    return this.app.create(dto) as Promise<SandboxResponseDto>;
  }

  @Get()
  @ApiOperation({ summary: 'List sandboxes, optionally filtered by projectId' })
  list(@Query() query: ListSandboxesQueryDto): Promise<SandboxResponseDto[]> {
    return this.app.list(query.projectId) as Promise<SandboxResponseDto[]>;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a sandbox by id' })
  get(@Param('id') id: string): Promise<SandboxResponseDto> {
    return this.app.get(id) as Promise<SandboxResponseDto>;
  }
}
