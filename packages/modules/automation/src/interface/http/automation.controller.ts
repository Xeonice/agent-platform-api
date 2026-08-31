import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type {
  AutomationDto,
  AutomationRunDto,
  PaginatedAutomationRuns,
  WebhookTestResult,
} from '@platform/contracts';
import { AutomationApplicationService } from '../../application/automation-application.service';
import {
  AutomationResponseDto,
  AutomationRunResponseDto,
  PaginatedAutomationRunsDto,
  UpdateAutomationDto,
  WebhookTestRequestDto,
  WebhookTestResultDto,
} from './dto/automation.dto';

/** 只用到 express `Response` 的这一样，避免为三个头引入 `express` 依赖（与 audit 同款）。 */
interface HeaderSettable {
  setHeader(name: string, value: string): unknown;
}

/**
 * 规则本体 + 运行历史 + webhook 测试（10 §6.5 / 27 §8）。
 *
 * ⚠️ **路由声明顺序有讲究，但不是靠顺序**：`webhook-test` 与 `runs/:runId` 都不会被
 * `:id` 遮住 —— 前者是字面段、后者段数不同。这里按「先具体后通用」排，是为了让读的人
 * 一眼看出哪些路径不是规则 id。
 *
 * ⛔ **不进 MCP**（27 §11.3）。
 */
@ApiTags('automation')
@Controller('automations')
export class AutomationController {
  constructor(private readonly app: AutomationApplicationService) {}

  /**
   * `POST /api/automations/webhook-test` —— 规则表单上的 [测试连接]（03 §8.5）。
   *
   * ⚠️ **它总是 200**，成功与失败都在 body 的 `ok` 里。这不是偷懒：调用方是一个想
   * 知道「地址通不通」的表单，把「对面返回 502」翻译成本接口的 502 会让前端的错误
   * 处理去解释一个不是它的失败。
   */
  @Post('webhook-test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a sample webhook payload (same timeout + SSRF policy)' })
  @ApiOkResponse({ type: WebhookTestResultDto })
  webhookTest(@Body() dto: WebhookTestRequestDto): Promise<WebhookTestResult> {
    return this.app.test(dto.url);
  }

  /** `GET /api/automations/runs/:runId` —— 单条运行记录（含 `outputSummary` 末尾 1KB）。 */
  @Get('runs/:runId')
  @ApiOperation({ summary: 'Get one automation run' })
  @ApiOkResponse({ type: AutomationRunResponseDto })
  @ApiNotFoundResponse()
  getRun(@Param('runId') runId: string): Promise<AutomationRunDto> {
    return this.app.getRun(runId);
  }

  /**
   * `GET /api/automations/runs/:runId/logs?offset=&limit=` —— **原始 stdout/stderr**，
   * 分页字节区间，默认回末尾 64KB（03 §8.6）。
   *
   * ⚠️ `text/plain` 而不是 JSON：正文是日志，不是结构。分页游标走响应头
   * （`x-log-offset` / `x-log-total` / `x-log-eof`），这样「继续往前翻」不需要先把
   * 整段正文解析成一个 JSON 字符串再取出来。
   */
  @Get('runs/:runId/logs')
  @Header('content-type', 'text/plain; charset=utf-8')
  @ApiOperation({ summary: 'Read a byte range of a run log (defaults to the trailing 64KB)' })
  @ApiQuery({ name: 'offset', required: false, description: 'absent ⇒ the trailing `limit` bytes' })
  @ApiQuery({ name: 'limit', required: false, description: 'default 65536, max 1048576' })
  @ApiOkResponse({
    description: 'Raw log bytes as UTF-8 text',
    headers: {
      'x-log-offset': { description: 'first byte of this slice', schema: { type: 'integer' } },
      'x-log-total': { description: 'total bytes on disk', schema: { type: 'integer' } },
      'x-log-eof': {
        description: '"true" when this slice reaches EOF',
        schema: { type: 'string' },
      },
    },
  })
  @ApiNotFoundResponse()
  async readRunLogs(
    @Param('runId') runId: string,
    @Res({ passthrough: true }) res: HeaderSettable,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ): Promise<string> {
    const slice = await this.app.readRunLogs(runId, toInt(offset), toInt(limit));
    // ⚠️ `passthrough: true` —— Nest 继续做序列化、全局 `ErrorEnvelopeFilter` 继续生效
    // （10A §3）。不加它就等于在这一个端点上把错误信封关掉了。
    res.setHeader('x-log-offset', String(slice.offset));
    res.setHeader('x-log-total', String(slice.totalBytes));
    res.setHeader('x-log-eof', String(slice.eof));
    return slice.content;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an automation rule' })
  @ApiOkResponse({ type: AutomationResponseDto })
  @ApiNotFoundResponse()
  get(@Param('id') id: string): Promise<AutomationDto> {
    return this.app.get(id);
  }

  /**
   * `PUT /api/automations/:id`。
   *
   * ★ **`timezone` 缺席 = 原样保留**（I-AUT-9）。前端只在用户显式改时区时才传它 ——
   * 顺手把当前浏览器时区再传一遍，会让一条「每天凌晨 3 点」的规则在用户换台机器后
   * 挪走 8 小时（03 §8.1「最难排查的一类 bug」）。
   */
  @Put(':id')
  @ApiOperation({ summary: 'Update a rule — omitting `timezone` keeps the snapshot (I-AUT-9)' })
  @ApiOkResponse({ type: AutomationResponseDto })
  @ApiNotFoundResponse()
  update(@Param('id') id: string, @Body() dto: UpdateAutomationDto): Promise<AutomationDto> {
    return this.app.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a rule (its run history cascades)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  remove(@Param('id') id: string): Promise<void> {
    return this.app.remove(id);
  }

  /** 动作而非字段更新（02 §5.1）。I-AUT-4：清零 `consecutiveFailures` 与 `degraded`。 */
  @Post(':id/enable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Re-enable a rule (clears failure count and the degraded flag)' })
  @ApiOkResponse({ type: AutomationResponseDto })
  @ApiNotFoundResponse()
  enable(@Param('id') id: string): Promise<AutomationDto> {
    return this.app.enable(id);
  }

  @Post(':id/disable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Disable a rule' })
  @ApiOkResponse({ type: AutomationResponseDto })
  @ApiNotFoundResponse()
  disable(@Param('id') id: string): Promise<AutomationDto> {
    return this.app.disable(id);
  }

  /**
   * `GET /api/automations/:id/runs?before=&limit=` —— **游标信封**（`{ items, hasMore }`，
   * 与 `GET /api/system/audit` 同形）。
   *
   * ⚠️ 上一版是 `?page=&pageSize=`。运行历史是**头部追加**的流，offset 分页会让翻页期间
   * 新落的 run 把下一页顶成上一页尾部的重复 —— **而且看起来完全正常**。`useAuditStream`
   * 的七条纪律之首点名的就是这里：「此前 `automationKeys.runs` 用的是 offset 页码，
   * 那套照抄过来会静默错位」。
   */
  @Get(':id/runs')
  @ApiOperation({ summary: 'List a rule’s run history, newest first (cursor)' })
  @ApiQuery({ name: 'before', required: false, description: 'run id; returns strictly older ones' })
  @ApiQuery({ name: 'limit', required: false, description: 'default 20, max 100' })
  @ApiOkResponse({ type: PaginatedAutomationRunsDto })
  @ApiNotFoundResponse()
  listRuns(
    @Param('id') id: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ): Promise<PaginatedAutomationRuns> {
    return this.app.listRuns(id, before === '' ? undefined : before, toInt(limit));
  }
}

function toInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
