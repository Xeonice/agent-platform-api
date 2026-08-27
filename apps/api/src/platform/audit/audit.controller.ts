import { createReadStream } from 'node:fs';
import { BadRequestException, Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  AUDIT_CATEGORIES,
  AUDIT_LIMIT_DEFAULT,
  AUDIT_LIMIT_MAX,
  AUDIT_SEVERITIES,
  AuditListDtoSchema,
  AuditQuerySchema,
  auditCursorConflictEnvelope,
  type AuditListDto,
} from '@platform/contracts';
import { AuditRepository } from './audit.repository';
import { AuditExportService } from './audit-export.service';
import { fromEpochMs } from '@platform/shared-kernel';

export class AuditQueryDto extends createZodDto(AuditQuerySchema) {}
export class AuditListResponseDto extends createZodDto(AuditListDtoSchema) {}

/** 只用到 express `Response` 的这两样，避免为一个 header 引入 `express` 依赖。 */
interface HeaderSettable {
  setHeader(name: string, value: string): unknown;
}

/**
 * 平台级审计流的 REST 外壳（shared/10 §6.6 / 27 §295-296 `listAudit` / `exportAudit`）。
 *
 * **两个端点都是只读的，也都不进 MCP**：审计面板是给人看的运维视图（P21-5 §10.1
 * 「读者：产品用户 / 管理员，在页面上看」），agent caller 拿它没有决策可做 —— 与
 * `GET /api/providers` 不进 MCP 同一条判据。
 */
@ApiTags('system')
@Controller('system')
export class AuditController {
  constructor(
    private readonly repo: AuditRepository,
    private readonly exporter: AuditExportService,
  ) {}

  /**
   * `GET /api/system/audit` —— 双向游标（10 §6.6.1）。
   *
   * ⚠️ **响应恒按 `seq` 降序**，与方向无关：`since` 的结果 prepend、`before` 的结果
   * append，前端两边都不用再排。
   *
   * ⚠️ **`hasMore` 在两个方向含义不同**：`since` 方向 = 「还有更新的没拉完」= **有
   * 断层**（异常风暴 30s 内 >200 条，一次拉不完，前端不得假装连续）；`before` 方向 =
   * 「还有更老的」= 可继续滚。
   */
  @Get('audit')
  @ApiOperation({
    summary:
      '平台级审计流。since/before 为按 seq 的双向游标（互斥，同传 400 VALIDATION_FAILED）；' +
      'from/to 是与游标正交的时间过滤。响应恒按 seq 降序 + hasMore。',
  })
  // ⚠️ **query 参数必须逐条 `@ApiQuery`，`@Query() dto` 反射不出来。** 实测：只写
  // `@Query() query: AuditQueryDto` 时 openapi.json 里这个端点是 `"parameters": []`
  // —— 校验照跑（管道认 DTO），但**契约里一个参数都没有**，前端 codegen 生成的调用
  // 签名因此不接受 `since`/`before`/`limit`。校验绿、契约空，两边都不会报错。
  // 本仓既有的带 query 端点（`GET /api/images?runtimeId=`）也是这么写的。
  @ApiQuery({
    name: 'since',
    required: false,
    type: Number,
    description: '向新翻页：返回 seq > since',
  })
  @ApiQuery({
    name: 'before',
    required: false,
    type: Number,
    description: '向老翻页：返回 seq < before',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description: 'ISO 时间下界（与游标正交）',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description: 'ISO 时间上界（与游标正交）',
  })
  @ApiQuery({ name: 'category', required: false, enum: AUDIT_CATEGORIES })
  // ⚠️ **不是 enum，是带说明的 string** —— 它接受逗号分隔的多值，而 openapi 的 query
  // enum 表达不了「子集」。声明成 enum 会让 codegen 出的签名拒掉 `warn,error`，也就是
  // 拒掉唯一能表达产品「仅告警」的取值（10 §6.6.1 / `AuditSeverityFilterSchema`）。
  @ApiQuery({
    name: 'severity',
    required: false,
    type: String,
    description:
      `逗号分隔的多值，取值 ${AUDIT_SEVERITIES.join(' / ')}，服务端按 IN 过滤；` +
      '单值向后兼容（`severity=error`），「仅告警」= `severity=warn,error`；' +
      '重复值去重，含非法值 → 400 VALIDATION_FAILED',
  })
  @ApiQuery({ name: 'subjectId', required: false, type: String })
  // ⚠️ **`type` 必须写在 `schema` 里面。** 显式 `schema` 会**整个覆盖** `type: Number`，
  // 产出的 schema 因此没有 `"type"`，codegen 出的是 `limit?: unknown` —— 同一个
  // operation 的 `since`/`before`（只写 `type: Number`、没写 `schema`）都好好拿到了
  // `number`。这是本文件顶上那段事故的**下一个变种**：上次是参数整个消失，这次是类型
  // 消失，两次都是「校验照跑、契约却是错的，两边 CI 全绿」。
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: {
      type: 'number',
      minimum: 1,
      maximum: AUDIT_LIMIT_MAX,
      default: AUDIT_LIMIT_DEFAULT,
    },
  })
  @ApiOkResponse({ type: AuditListResponseDto })
  list(@Query() query: AuditQueryDto): AuditListDto {
    // 互斥判定（10 §6.6.1）。放在这里而不是 schema 的 `.refine()` 里 —— 理由见
    // `AuditQuerySchema` 的注释：openapi 那一份 query 声明来自下面的 `@ApiQuery`，
    // 藏进 ZodEffects 的规则在契约里彻底看不见。
    if (query.since !== undefined && query.before !== undefined) {
      throw new BadRequestException(auditCursorConflictEnvelope());
    }
    return this.repo.list({
      ...(query.since === undefined ? {} : { since: query.since }),
      ...(query.before === undefined ? {} : { before: query.before }),
      ...(query.from === undefined ? {} : { from: fromEpochMs(Date.parse(query.from)) }),
      ...(query.to === undefined ? {} : { to: fromEpochMs(Date.parse(query.to)) }),
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.severity === undefined ? {} : { severity: query.severity }),
      ...(query.subjectId === undefined ? {} : { subjectId: query.subjectId }),
      limit: query.limit,
    });
  }

  /**
   * `GET /api/system/audit/export` —— tar.gz（P21-5 §10.3）。
   *
   * 包在服务端先落成临时文件再回流：出错时还能改回一个 500 信封，而流一旦开始写就
   * 没有回头路了。流走完（含客户端中断）即删临时目录。
   */
  @Get('audit/export')
  @ApiOperation({
    summary:
      '导出 tar.gz：audit.jsonl + runtime.log + diagnose.json + export-range.json。' +
      '取「最近 24h」与「50MB」先到者，实际截取范围写在 export-range.json 里。',
  })
  @ApiProduces('application/gzip')
  @ApiOkResponse({ description: 'tar.gz 归档字节流' })
  async export(@Res({ passthrough: true }) res: HeaderSettable): Promise<StreamableFile> {
    const packed = await this.exporter.pack();
    res.setHeader('content-type', 'application/gzip');
    res.setHeader('content-disposition', `attachment; filename="${packed.filename}"`);
    const stream = createReadStream(packed.path);
    // `close` 而不是 `end`：客户端中途断开时 `end` 不会触发，临时目录会留在盘上，
    // 而这个目录里装着刚导出的（已脱敏但仍敏感的）运行日志。
    stream.on('close', () => void packed.dispose());
    return new StreamableFile(stream);
  }
}
