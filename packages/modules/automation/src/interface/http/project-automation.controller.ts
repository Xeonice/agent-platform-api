import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AutomationDto } from '@platform/contracts';
import { AutomationApplicationService } from '../../application/automation-application.service';
import { AutomationResponseDto, CreateAutomationDto } from './dto/automation.dto';

/**
 * 规则的**项目子资源**面（10 §6.5 第一行 / 27 §8）。
 *
 * ⚠️ **只有 list 与 create 挂在 `/projects/:id/` 下面**，其余全部走 `/automations/:id`
 * （见 `AutomationController`）。判据与保留卷那次相反：规则**是**项目的子资源
 * （`project_id` 是 FK RESTRICT、删项目要先删规则），所以「在这个项目下建一条」
 * 天然带项目 id；而拿到 id 之后的增删改查不需要再重复一次归属。
 *
 * ⛔ **不进 MCP**（27 §11.3「automation 全部（11 个）」）：管理员配置动作，
 * 一个被诱导的上层 agent 不该能给你排一条每天凌晨跑的任务。
 */
@ApiTags('automation')
@Controller('projects')
export class ProjectAutomationController {
  constructor(private readonly app: AutomationApplicationService) {}

  @Get(':id/automations')
  @ApiOperation({ summary: "List a project's automation rules" })
  @ApiOkResponse({ type: AutomationResponseDto, isArray: true })
  list(@Param('id') projectId: string): Promise<AutomationDto[]> {
    return this.app.listByProject(projectId);
  }

  /**
   * ⚠️ `timezone` 是**必填**，且创建之后就是快照（I-AUT-9）。前端传当时的浏览器时区；
   * 编辑时**不要**再传一遍（27 §8 前端第 0 条）。
   */
  @Post(':id/automations')
  @ApiOperation({ summary: 'Create an automation rule (timezone is snapshotted here)' })
  @ApiCreatedResponse({ type: AutomationResponseDto })
  @ApiNotFoundResponse({ description: 'unknown project' })
  @ApiConflictResponse({ description: 'AUTOMATION_LIMIT_REACHED — 20 rules per project (I-AUT-7)' })
  create(@Param('id') projectId: string, @Body() dto: CreateAutomationDto): Promise<AutomationDto> {
    return this.app.create(projectId, dto);
  }
}
