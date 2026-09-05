import { Body, ConflictException, Controller, Get, HttpCode, Post, Put, Res } from '@nestjs/common';
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
  AccessPasscodeActionSchema,
  AccessPasscodeResultSchema,
  InitRequestSchema,
  InitStatusDtoSchema,
  SystemProvidersDtoSchema,
  SystemResourcesDtoSchema,
  SystemSettingsDtoSchema,
  UpdateSystemSettingsRequestSchema,
} from '@platform/contracts';
import type {
  AccessPasscodeResult,
  InitStatusDto,
  SystemProvidersDto,
  SystemResourcesDto,
  SystemSettingsDto,
} from '@platform/contracts';
import { AccessPasscodeService } from '../access-passcode/access-passcode.service';
import { InitializationService } from './initialization.service';
import { SystemSettingsService } from './system-settings.service';
import { SystemResourcesService } from './system-resources.service';
import { SystemProvidersService } from './system-providers.service';
import { DiagnosticsService } from './diagnostics/diagnostics.service';
import { PresetImageProvisioner } from './preset-image/preset-image-provisioner';
import { PRESET_IMAGE_NOT_PROVISIONABLE } from '@platform/contracts';
import { SseWriter, type SseResponse } from './diagnostics/sse-writer';

export class InitStatusResponseDto extends createZodDto(InitStatusDtoSchema) {}
export class InitRequestDto extends createZodDto(InitRequestSchema) {}
export class SystemSettingsResponseDto extends createZodDto(SystemSettingsDtoSchema) {}
export class UpdateSystemSettingsDto extends createZodDto(UpdateSystemSettingsRequestSchema) {}
export class SystemResourcesResponseDto extends createZodDto(SystemResourcesDtoSchema) {}
export class SystemProvidersResponseDto extends createZodDto(SystemProvidersDtoSchema) {}
export class AccessPasscodeRequestDto extends createZodDto(AccessPasscodeActionSchema) {}
export class AccessPasscodeResponseDto extends createZodDto(AccessPasscodeResultSchema) {}

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
    private readonly provisioner: PresetImageProvisioner,
    private readonly settings: SystemSettingsService,
    private readonly resources: SystemResourcesService,
    private readonly providers: SystemProvidersService,
    private readonly diagnostics: DiagnosticsService,
    private readonly passcodes: AccessPasscodeService,
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

  /**
   * ⚠️ **PUT 而不是 PATCH `settings`，且响应里有一个平台此后再也不会说的字符串。**
   * 口令是**动作**（换一把钥匙），不是 `system_settings` 上的一个字段更新 ——
   * 判据同 02 §5.1 末段，也同 `PATCH /api/images/:id {isActive:true}` 被打回
   * `POST /activate`：副作用大于字面的那一类，不走部分更新。
   *
   * ⛔ **明文只在这一个响应体里出现一次**（11 §3.1）。它不进日志、不进审计
   * （`access-audit.ts` 的构造函数根本不接受口令参数）、不进 `GET /settings`。
   */
  @Put('access-passcode')
  @ApiOperation({
    summary:
      '启用 / 重新生成 / 关闭访问口令。enable+regenerate 一次性返回 16 位明文，此后只存 hash；重新生成不影响已通过的 session',
  })
  @ApiOkResponse({ type: AccessPasscodeResponseDto })
  setAccessPasscode(@Body() body: AccessPasscodeRequestDto): AccessPasscodeResult {
    return this.passcodes.apply(body);
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

  /**
   * `POST /api/system/preset-image/provision` —— **平台自己把预制镜像搬到位**。
   *
   * ── 它修的是什么 ────────────────────────────────────────────────────────
   * 预制镜像缺位时，诊断第 ⑧ 项原本只会报一个 ❌ 并给出两条 `docker` 命令 —— 而
   * 2026-09-05 实测里那张镜像的字节**就躺在本机 docker 库**，其中一条命令还是让用户
   * 重新 build 一遍已经有的东西。⛔ **平台明明能做而让用户去敲命令，那不是指路，
   * 是把自己的活派给用户**（P21-8 §2 ⇒ 新判据）。
   *
   * ⚠️ **SSE 而不是「POST 完了轮询」**：这是分钟级操作，而它最要紧的产出恰恰是**过程**
   * ——失败在下载、校验、装载还是推送，四件事的下一步完全不同。
   *
   * ⚠️ **两种 409 两个码**（与 `/init` 同一条纪律）：`PRESET_IMAGE_NOT_PROVISIONABLE`
   * 是「这台机器上搬不了，去构建」，`PRESET_IMAGE_PROVISION_IN_FLIGHT` 是「已经在搬了，
   * 等着」——处置相反，合成一个码会让前端只能二选一地猜。
   *
   * ⛔ **409 必须在开流之前判掉。** 一旦发出 SSE 头，状态码就定死在 200 了，此时再想
   * 说「不可搬运」只能塞进流里 —— 而照着 openapi 生成的调用方看到的是一次成功的 200。
   */
  @Post('preset-image/provision')
  @HttpCode(200)
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description:
      'SSE 帧流：event: stage（plan/fetch/verify/load/register）+ done。帧类型手写于两仓 sse-protocol.ts',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  @ApiOperation({
    summary:
      '把预制镜像搬到位（只搬不建）：本机 docker 库已有 ⇒ 直接推；发布资产清单命中 ⇒ 校验 sha256 后装载再推。搬不了返 409，已在搬返 409（两个码）',
  })
  async provisionPresetImage(@Res() res: SseResponse): Promise<void> {
    // ⛔ **先判可行性，再开流** —— 一旦发出 SSE 头，状态码就定死在 200 了。
    //    ⚠️ 抛 `ConflictException` 而不是手写 `res.status(409).json(...)`：走全局
    //    `ErrorEnvelopeFilter` 才能拿到与其余端点一致的错误信封（`traceId` 等）。
    //    手写那份看起来一样，但少了 traceId —— 而排障时那正是要拿来串日志的那个字段。
    const plan = await this.provisioner.plan();
    if (!plan.provisionable) {
      throw new ConflictException({
        code: PRESET_IMAGE_NOT_PROVISIONABLE,
        message: plan.why,
        retryable: false,
        // 只读的探查，一个字节都没写 —— 前端据此渲染成「就地改」而不是「重试」。
        sideEffectFree: true,
      });
    }

    const writer = new SseWriter(res);
    writer.open();
    try {
      for await (const e of this.provisioner.provision()) {
        writer.send({ event: 'stage', ...e });
      }
      writer.send({ event: 'done', ok: true });
    } catch (e) {
      // ⚠️ 流已经开了 ⇒ 失败只能在流里说，但**必须说得出是哪一阶段**。
      //    `done { ok: false }` 而不是静静断开：断开在前端看来与网络抖动无法区分。
      writer.send({ event: 'done', ok: false, error: (e as Error).message });
    } finally {
      writer.close();
    }
  }
}
