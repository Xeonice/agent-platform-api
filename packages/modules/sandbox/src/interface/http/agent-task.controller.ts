import { Readable } from 'node:stream';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  StreamableFile,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AgentTaskDto } from '@platform/contracts';
import { AgentTaskApplicationService } from '../../application/agent-task.service';
import { AgentTaskResponseDto, RunAgentTaskDto } from './dto/agent-task.dto';

/**
 * REST protocol shell for headless Tasks (02 §5.1). Thin adapter: it injects the SAME
 * `AgentTaskApplicationService` the MCP tool and the `/tasks` gateway inject, and does
 * no business logic of its own.
 *
 * It is a SECOND controller on the `sandboxes` prefix rather than more methods on
 * `SandboxController` because these three paths are one cohesive resource with its own
 * lifecycle; nothing about them shares state with sandbox CRUD. Their route patterns
 * have a different segment count from `:id`, so no route shadows another.
 */
@ApiTags('sandbox')
@Controller('sandboxes')
export class AgentTaskController {
  constructor(private readonly app: AgentTaskApplicationService) {}

  /**
   * 202, not 201: the answer means "accepted and now running", and the run itself can
   * take up to four hours. The body carries the whole DTO so the caller has the id AND
   * the initial state without a second round trip.
   */
  @Post(':id/runtimes/:rt/tasks')
  @HttpCode(202)
  @ApiOperation({ summary: 'Start a headless agent Task in a sandbox' })
  @ApiResponse({ status: 202, type: AgentTaskResponseDto })
  run(
    @Param('id') sandboxId: string,
    @Param('rt') runtimeId: string,
    @Body() dto: RunAgentTaskDto,
  ): Promise<AgentTaskDto> {
    return this.app.run(sandboxId, runtimeId, dto);
  }

  /**
   * The sandbox's run history, newest first.
   *
   * ⚠️ IT IS DECLARED BEFORE `:id/tasks/:taskId` ON PURPOSE — not that the two could
   * ever collide (different segment counts), but so the pair reads in the order a
   * client discovers them: list, then open one.
   */
  @Get(':id/tasks')
  @ApiOperation({ summary: 'List the headless Tasks of a sandbox, newest first' })
  @ApiOkResponse({ type: AgentTaskResponseDto, isArray: true })
  list(@Param('id') sandboxId: string): Promise<AgentTaskDto[]> {
    return this.app.listBySandbox(sandboxId);
  }

  @Get(':id/tasks/:taskId')
  @ApiOperation({ summary: 'Get a headless Task by id' })
  @ApiOkResponse({ type: AgentTaskResponseDto })
  get(@Param('id') sandboxId: string, @Param('taskId') taskId: string): Promise<AgentTaskDto> {
    return this.app.get(sandboxId, taskId);
  }

  /**
   * 202: the signal is on its way, the terminal state follows on the stream.
   *
   * Answering 200 with `status:'killed'` would be a lie — the process is still running
   * until the signal lands, and the platform still has to collect the artifacts and the
   * exit code before the run is really over.
   */
  @Post(':id/tasks/:taskId/cancel')
  @HttpCode(202)
  @ApiOperation({ summary: 'Ask a running headless Task to stop (SIGTERM → 5s → SIGKILL)' })
  @ApiResponse({ status: 202, type: AgentTaskResponseDto })
  cancel(@Param('id') sandboxId: string, @Param('taskId') taskId: string): Promise<AgentTaskDto> {
    return this.app.cancel(sandboxId, taskId);
  }

  /**
   * Stream one artifact straight out of the sandbox.
   *
   * It STREAMS rather than buffering because an artifact is whatever the agent chose
   * to produce — a screenshot, an archive, a long log — and holding an arbitrary one in
   * the platform's memory to hand it over is a denial-of-service the platform inflicts
   * on itself.
   *
   * `:name` is a path RELATIVE to the artifact directory and may contain `/`, which a
   * caller sends percent-encoded (`out%2Freport.md`). Absolute paths and `..` segments
   * are refused in the application layer, before anything is resolved.
   */
  @Get(':id/tasks/:taskId/artifacts/:name')
  @Header('content-type', 'application/octet-stream')
  @ApiOperation({ summary: 'Download one artifact a headless Task produced' })
  @ApiOkResponse({
    description: 'Raw artifact bytes (application/octet-stream)',
    headers: {
      'content-length': {
        // `required: false` is the literal contract, not hedging — see the note on
        // `size` below for the cases in which the platform deliberately stays silent.
        required: false,
        description:
          'Total bytes, present only when the platform could measure the file without ' +
          'guessing (a finished Task whose file plane reported a size). A client MUST ' +
          'treat its absence as normal and stream without a progress indicator.',
        schema: { type: 'integer', format: 'int64', minimum: 0 },
      },
    },
  })
  async artifact(
    @Param('id') sandboxId: string,
    @Param('taskId') taskId: string,
    @Param('name') name: string,
  ): Promise<StreamableFile> {
    const artifact = await this.app.openArtifact(sandboxId, taskId, name);
    // the file plane's contract type is the structural `NodeJS.ReadableStream`;
    // `StreamableFile` wants a real `Readable`. Adapt only when it is not one already,
    // so the common case stays a plain hand-off with no extra copy.
    const readable =
      artifact.stream instanceof Readable ? artifact.stream : Readable.from(artifact.stream);
    return new StreamableFile(readable, {
      // the basename only: the relative path is the platform's addressing scheme, not
      // something to impose on the downloader's filesystem.
      disposition: `attachment; filename="${basenameOf(artifact.name)}"`,
      // ⚠️ OMITTED, NOT GUESSED, WHEN THE SIZE IS NOT KNOWN. `length: undefined` makes
      // the adapter skip the header entirely (`setHeaderIfNotExists` ignores undefined),
      // and that is the whole point: a stream sent WITHOUT `content-length` is chunked
      // and arrives complete, while a stream sent with the WRONG one is truncated at
      // that byte or hangs waiting for bytes that will never come. The frontend is
      // built for the header to be missing — it only loses the progress bar — so the
      // asymmetry is entirely one-sided.
      ...(artifact.size !== undefined ? { length: artifact.size } : {}),
    });
  }
}

function basenameOf(name: string): string {
  const i = name.lastIndexOf('/');
  const base = i < 0 ? name : name.slice(i + 1);
  // strip anything that could break out of the quoted header value.
  return base.replace(/["\\\r\n]/g, '');
}
