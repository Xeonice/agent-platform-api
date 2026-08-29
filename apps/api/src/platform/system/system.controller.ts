import { Body, Controller, Get, HttpCode, Post, Put, Res } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  InitRequestSchema,
  InitStatusDtoSchema,
  SystemProvidersDtoSchema,
  SystemResourcesDtoSchema,
  SystemSettingsDtoSchema,
  UpdateSystemSettingsRequestSchema,
} from '@platform/contracts';
import type {
  InitStatusDto,
  SystemProvidersDto,
  SystemResourcesDto,
  SystemSettingsDto,
} from '@platform/contracts';
import { InitializationService } from './initialization.service';
import { SystemSettingsService } from './system-settings.service';
import { SystemResourcesService } from './system-resources.service';
import { SystemProvidersService } from './system-providers.service';
import { DiagnosticsService } from './diagnostics/diagnostics.service';
import { SseWriter, type SseResponse } from './diagnostics/sse-writer';

export class InitStatusResponseDto extends createZodDto(InitStatusDtoSchema) {}
export class InitRequestDto extends createZodDto(InitRequestSchema) {}
export class SystemSettingsResponseDto extends createZodDto(SystemSettingsDtoSchema) {}
export class UpdateSystemSettingsDto extends createZodDto(UpdateSystemSettingsRequestSchema) {}
export class SystemResourcesResponseDto extends createZodDto(SystemResourcesDtoSchema) {}
export class SystemProvidersResponseDto extends createZodDto(SystemProvidersDtoSchema) {}

/**
 * 系统状态与初始化的 REST 外壳（10 §6.6；23 D-11/D-12：系统端点不属任何限界上下文）。
 *
 * **六个端点都不进 MCP**，与 `GET /api/providers` / `/api/system/audit` 同一条判据：
 * 它们是给**人**看的运维视图与一次性的部署动作，agent caller 拿它们没有决策可做。
 * 尤其 `/init` —— 让一个上层 agent 能「完成平台初始化」是把一次不可逆的部署动作交给
 * 一个不知道自己在按什么的调用方。
 */
@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(
    private readonly init: InitializationService,
    private readonly settings: SystemSettingsService,
    private readonly resources: SystemResourcesService,
    private readonly providers: SystemProvidersService,
    private readonly diagnostics: DiagnosticsService,
  ) {}

  @Get('init-status')
  @ApiOperation({
    summary:
      '冷启动首屏据此决定是否进初始化向导；附上次出网检测结果（不重跑检测，进向导直接渲染历史结果）',
  })
  @ApiOkResponse({ type: InitStatusResponseDto })
  initStatus(): InitStatusDto {
    return this.settings.initStatus();
  }

  /**
   * ⚠️ **201 而不是 200 是刻意的**（Nest 对 POST 的默认值）：它创建了「已初始化」这个
   * 一次性状态。而已初始化再调是 **409**，不是幂等 200 —— 见 `InitializationService`。
   */
  @Post('init')
  @ApiOperation({
    summary:
      '完成初始化：跑一轮出网检测（复用 /diagnose 的探测）+ 存代理 + 写 initialized=true。一次性操作，已初始化返 409',
  })
  // ⚠️ `@ApiCreatedResponse` 而不是 `@ApiOkResponse`：Nest 对 POST 真的回 201，而契约
  //    里写 200 会让 codegen 出的调用方按 200 收 —— 一个「契约与实现各自正确、合起来
  //    对不上」的经典形状（本仓在 query 参数上刚踩过两次）。
  @ApiCreatedResponse({ type: InitStatusResponseDto })
  initialize(@Body() body: InitRequestDto): Promise<InitStatusDto> {
    return this.init.initialize(body);
  }

  @Get('settings')
  @ApiOperation({ summary: '运行期配置（代理 / 公开地址 / 版本）。⛔ 永不回显口令 hash' })
  @ApiOkResponse({ type: SystemSettingsResponseDto })
  getSettings(): SystemSettingsDto {
    return this.settings.settings();
  }

  /**
   * ⚠️ **只存配置、不放行。** 放行是 `POST /api/system/init` 的事，而且是一次性的。
   * body 里没有 `initialized` 不是遗漏 —— 那条边界就落在这里。
   */
  @Put('settings')
  @ApiOperation({
    summary:
      '改运行期配置（proxyConfig / publicBaseUrl；null=清空，缺席=不改）。⚠️ 不写 initialized',
  })
  @ApiOkResponse({ type: SystemSettingsResponseDto })
  updateSettings(@Body() body: UpdateSystemSettingsDto): SystemSettingsDto {
    return this.settings.update(body);
  }

  @Get('resources')
  @ApiOperation({ summary: 'CPU / RAM / 磁盘水位 + 保留卷占用 + 活跃 Task 数' })
  @ApiOkResponse({ type: SystemResourcesResponseDto })
  getResources(): Promise<SystemResourcesDto> {
    return this.resources.snapshot();
  }

  @Get('providers')
  @ApiOperation({
    summary:
      '运维看板：已注册 provider / runtime / imageSpec + capabilities + 健康与最近 1h 失败率。⚠️ 与 GET /api/providers 是两个端点',
  })
  @ApiOkResponse({ type: SystemProvidersResponseDto })
  getProviders(): Promise<SystemProvidersDto> {
    return this.providers.overview();
  }

  /**
   * `POST /api/system/diagnose` —— **SSE**（02 §5.3 定案）。
   *
   * ⚠️ **`@Res()` 接管响应，所以这里没有返回值**，openapi 那一侧也因此只能声明
   * content-type（10 §6：`openapi-typescript` 只能生成 `/diagnose` 的 content-type 声明，
   * **流帧的类型必须手写**）。手写的那份在两仓的 `sse-protocol.ts`，由 B5 对账。
   *
   * ⚠️ **`@HttpCode(200)`**：Nest 对 POST 默认 201，而 SSE 是一条持续的 200 流。
   * 201 会让一部分 SSE 客户端（以及照着 openapi 生成的调用方）当成「已创建」而不是
   * 「开始流」。
   *
   * ⚠️ **它是 POST 而不是 GET**，尽管诊断是只读的：`EventSource` 不支持带 body，
   * 而产品要的是「点一下按钮跑一轮」而不是「订阅一条持续的流」。前端用
   * `fetch` + `ReadableStream` 消费（F21-5 §7.1）。
   */
  @Post('diagnose')
  @HttpCode(200)
  @ApiProduces('text/event-stream')
  // ⚠️ **必须显式声明 content**，`@ApiProduces` 单独用产不出 `content` 那一节 —— 实测
  //    只有它时 openapi.json 里是 `"200": {"description": ""}`，**连 content-type 都没有**。
  //    而 10 §6 对这个端点的全部要求就是那一行 content-type 声明（流帧类型手写）。
  //    schema 是 `string`：SSE 的响应体在 openapi 的世界里就是一条文本流，帧的形状由
  //    两仓的 `sse-protocol.ts` 承担 —— 在这里编一个对象 schema 会**对 codegen 撒谎**，
  //    生成出一个「一次拿到一个 DiagnoseFrame」的签名，而实际是一条流。
  @ApiResponse({
    status: 200,
    description:
      'SSE 帧流：event: start / check / done。帧的 TypeScript 类型是手写的（两仓 sse-protocol.ts，B5 跨仓对账），openapi 只声明 content-type',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  @ApiOperation({
    summary:
      '八项诊断，SSE 逐项流式（帧类型手写于两仓 sse-protocol.ts）。八项并行、单项超时 5s，整轮 ≈ 最慢那项；断连即中止剩余检查',
  })
  async diagnose(@Res() res: SseResponse): Promise<void> {
    const writer = new SseWriter(res);
    const controller = new AbortController();
    writer.onClose(() => controller.abort());
    writer.open();
    try {
      await this.diagnostics.run((frame) => writer.send(frame), controller.signal);
    } finally {
      writer.close();
    }
  }
}
