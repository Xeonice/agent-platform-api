import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { ExecResult, SandboxDto } from '@platform/contracts';
import { SandboxApplicationService } from '../../application/sandbox-application.service';
import {
  CreateSandboxDto,
  DestroySandboxDto,
  ExecInSandboxDto,
  ExecResultResponseDto,
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
  // ⚠️ 没有这行 `@ApiQuery`，`projectId` **不会进 openapi**（`parameters: []`）——
  // `@Query()` + createZodDto 不足以让 swagger 认出查询参数。后果不是"文档不全"：
  // 前端用的是按 openapi 生成类型收紧的 typed client，参数不在契约里就**根本传不了**。
  @ApiQuery({ name: 'projectId', required: false, type: String })
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

  /**
   * ⚠️ POST ACTION SUB-PATHS, NOT `PATCH { status }` (02 §5.1 末段, 审计 P2-7). The
   * judgement is 「会不会产生资源之外的副作用」: these two start and stop a real
   * instance — a container/micro-VM boots, a CLI is re-verified, a credential is
   * re-injected. `PATCH /api/images/:id` stays a PATCH by the same rule, because it
   * only writes record fields.
   */
  @Post(':id/start')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Start a stopped sandbox. Returns as soon as the start is accepted; progress on WS.',
  })
  @ApiOkResponse({ type: SandboxResponseDto })
  start(@Param('id') id: string): Promise<SandboxDto> {
    return this.app.start(id);
  }

  @Post(':id/stop')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop a running sandbox, keeping its instance and workspace' })
  @ApiOkResponse({ type: SandboxResponseDto })
  stop(@Param('id') id: string): Promise<SandboxDto> {
    return this.app.stop(id);
  }

  /**
   * ⚠️ NON-INTERACTIVE ONLY (27 §2). An interactive TTY is WS `/terminal` and a long
   * agent run is `POST :id/runtimes/:rt/tasks`; this is the one-shot in between.
   */
  @Post(':id/exec')
  @HttpCode(200)
  @ApiOperation({ summary: 'Run one non-interactive command in a sandbox (TTY goes over WS)' })
  @ApiOkResponse({ type: ExecResultResponseDto })
  exec(@Param('id') id: string, @Body() dto: ExecInSandboxDto): Promise<ExecResult> {
    return this.app.exec(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Destroy a sandbox (optionally keeping its workspace)' })
  @ApiNoContentResponse()
  destroy(@Param('id') id: string, @Body() body: DestroySandboxDto): Promise<void> {
    return this.app.destroy(id, body ?? {});
  }
}
