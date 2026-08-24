import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { ProjectBranches, ProjectDto } from '@platform/contracts';
import { ProjectApplicationService } from '../../application/project-application.service';
import { CreateProjectDto, DeleteProjectDto, ProjectResponseDto } from './dto/project.dto';

/**
 * REST protocol shell for projects (02 §5.1, shared/10 §6). Thin adapter over the
 * SAME ProjectApplicationService the MCP tools use. git create is 202 (clone runs
 * in the background); empty create is 201.
 *
 * `branches` and `sync` are REST-only on purpose (27 §3 lists 「—」 for their MCP
 * column): the branch list is UI plumbing for a picker, and a sync is a long remote
 * operation whose only caller is a person looking at the project bar.
 */
@ApiTags('project')
@Controller('projects')
export class ProjectController {
  constructor(private readonly app: ProjectApplicationService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Create a project (git ⇒ async clone, empty ⇒ ready); always 202' })
  @ApiAcceptedResponse({ type: ProjectResponseDto })
  @ApiConflictResponse({ description: 'a project with that name already exists (I-PRJ-4)' })
  create(@Body() dto: CreateProjectDto): Promise<ProjectDto> {
    return this.app.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all projects' })
  @ApiOkResponse({ type: ProjectResponseDto, isArray: true })
  list(): Promise<ProjectDto[]> {
    return this.app.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a project by id' })
  @ApiOkResponse({ type: ProjectResponseDto })
  get(@Param('id') id: string): Promise<ProjectDto> {
    return this.app.get(id);
  }

  @Post(':id/retry-clone')
  @HttpCode(202)
  @ApiOperation({ summary: 'Retry a failed clone' })
  @ApiAcceptedResponse({ type: ProjectResponseDto })
  retryClone(@Param('id') id: string): Promise<ProjectDto> {
    return this.app.retryClone(id);
  }

  @Post(':id/convert-to-empty')
  @HttpCode(200)
  @ApiOperation({ summary: 'Convert a failed git project into an empty one' })
  @ApiOkResponse({ type: ProjectResponseDto })
  convertToEmpty(@Param('id') id: string): Promise<ProjectDto> {
    return this.app.convertToEmpty(id);
  }

  @Post(':id/cancel-clone')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel an in-progress clone' })
  @ApiOkResponse({ type: ProjectResponseDto })
  cancelClone(@Param('id') id: string): Promise<ProjectDto> {
    return this.app.cancelClone(id);
  }

  @Get(':id/branches')
  @ApiOperation({
    summary: "List the branches in the project's baseline (local refs; no network)",
  })
  @ApiOkResponse({ schema: { type: 'array', items: { type: 'string' } } })
  listBranches(@Param('id') id: string): Promise<ProjectBranches> {
    return this.app.listBranches(id);
  }

  @Post(':id/sync')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sync the baseline from its remote (git fetch --all)' })
  @ApiOkResponse({ type: ProjectResponseDto })
  @ApiConflictResponse({ description: 'the project is not ready (or has no remote)' })
  sync(@Param('id') id: string): Promise<ProjectDto> {
    return this.app.syncBaseline(id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a project (optionally keeping its baseline)' })
  @ApiNoContentResponse()
  delete(@Param('id') id: string, @Body() body: DeleteProjectDto): Promise<void> {
    return this.app.delete(id, body ?? {});
  }
}
