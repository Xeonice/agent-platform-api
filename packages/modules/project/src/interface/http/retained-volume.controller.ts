import { Readable } from 'node:stream';
import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { RetainedVolumeDto } from '@platform/contracts';
import { RetainedVolumeService } from '../../application/retained-volume.service';
import { RetainedVolumeResponseDto } from './dto/retained-volume.dto';

/**
 * 「已保留卷」的 REST 壳（10 §6.2 / 27 §2 / 03 §7.7）。
 *
 * ⚠️ **统一资源前缀 `/api/retained-volumes`，不挂在 `/projects/:id/` 下面**（P2-5）：
 * 卷的生命周期长于 sandbox 记录、也不随项目删除级联（13 §2.2.2），把它做成项目的
 * 子资源会让「项目删了、卷还在」这件既定语义在 URL 上讲不通。
 *
 * ⛔ **不进 MCP**（27 §2）：列表/删除是人在项目菜单里做的运维动作，而 `/archive` 是
 * 二进制流，不适合当 tool 返回（与 `downloadTaskArtifact` 同理）。
 *
 * ⛔ **没有「恢复」端点。** P20 §6 明写它的语义还没裁（恢复成一个新 Task？覆盖现有
 * 工作区？），本轮不做 —— 猜一个语义出来比缺一个端点贵。
 */
@ApiTags('project')
@Controller('retained-volumes')
export class RetainedVolumeController {
  constructor(private readonly app: RetainedVolumeService) {}

  @Get()
  @ApiOperation({ summary: 'List retained workspace volumes (cleaned-up ones excluded)' })
  @ApiQuery({ name: 'projectId', required: false })
  @ApiOkResponse({ type: RetainedVolumeResponseDto, isArray: true })
  list(@Query('projectId') projectId?: string): Promise<RetainedVolumeDto[]> {
    return this.app.list(projectId);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a retained volume now (the record stays, for audit)' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'unknown id, or already cleaned up (I-RV-2)' })
  remove(@Param('id') id: string): Promise<void> {
    return this.app.remove(id);
  }

  /**
   * 整包下载 —— **tar，不压缩**，带**精确** `Content-Length`。
   *
   * gzip 之后的大小只有真压完才知道（内容熵决定），而响应头必须先发 ⇒ 边压边传就给
   * 不出 `Content-Length` ⇒ 浏览器进度条显示「未知大小」。tar 的大小是确定的算术
   * （内容 + 512 字节块头 + padding），可精确预计算 ⇒ **浏览器原生进度条直接可用、
   * 前端零代码**。代价实测只有 9 MB（14 MB vs 4.8 MB），局域网内不值得为它换掉进度。
   *
   * 包里装什么由 git 口径决定（已跟踪 + 未跟踪未 ignore，`.git` 保留，`.gitignore`
   * 命中的不进）——实测本仓 web 工作区 1.0 GB → 14 MB。口径全文见 10 §6。
   */
  @Get(':id/archive')
  @Header('content-type', 'application/x-tar')
  @ApiOperation({ summary: 'Download the whole retained volume as an uncompressed tar stream' })
  @ApiOkResponse({
    description: 'Uncompressed tar bytes (application/x-tar)',
    headers: {
      'content-length': {
        required: true,
        description:
          'Exact archive size in bytes. It is computable BEFORE the first byte is sent ' +
          'precisely because the archive is not compressed — that is what keeps the ' +
          "browser's native download progress bar working.",
        schema: { type: 'integer', format: 'int64', minimum: 0 },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'unknown id, already cleaned up, or gone from disk' })
  async archive(@Param('id') id: string): Promise<StreamableFile> {
    const archive = await this.app.openArchive(id);
    const readable =
      archive.stream instanceof Readable ? archive.stream : Readable.from(archive.stream);
    return new StreamableFile(readable, {
      disposition: `attachment; filename="${archive.filename}"`,
      // ⚠️ 这个数与流出去的字节数**逐字节相等**（`tar-archive.ts` 的定案 ③）。带错的
      // 长度比不带更坏：流会在那个字节被截断，或吊死在永远不会到来的字节上。
      length: archive.sizeBytes,
      type: 'application/x-tar',
    });
  }
}
