import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { GitTestRequestSchema } from '@platform/contracts';
import type {
  GitTestRequestInput,
  GitTestResult,
  MaskedGitCredential,
  StoreGitCredentialResult,
} from '@platform/contracts';
import { CredentialApplicationService } from '../../application/credential-application.service';
import {
  CreateGitCredentialDto,
  GitTestResultResponseDto,
  InlineGitTestDto,
  MaskedGitCredentialResponseDto,
  StoredGitTestDto,
  StoreGitCredentialResponseDto,
} from './dto/credential.dto';

/**
 * REST protocol shell for Git credentials (02 §5.1, 27 §5). Git credentials are
 * REST-ONLY — they are NOT registered to MCP (05 §3.2). `GET /api/credentials`
 * requires `kind` and MVP accepts ONLY `kind=git` (a non-git value → 400) so a
 * runtime credential never has a second reachable read path.
 */
@ApiTags('credential')
@Controller('credentials')
export class CredentialController {
  constructor(private readonly app: CredentialApplicationService) {}

  @Get()
  @ApiOperation({ summary: 'List git credentials (masked). `kind` is required and must be `git`.' })
  @ApiQuery({ name: 'kind', required: true, enum: ['git'] })
  @ApiOkResponse({ type: MaskedGitCredentialResponseDto, isArray: true })
  list(@Query('kind') kind?: string): Promise<MaskedGitCredential[]> {
    if (kind !== 'git') {
      throw new BadRequestException("query parameter 'kind' is required and must be 'git'");
    }
    return this.app.listGitCredentials();
  }

  @Post('git')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Store a git credential (ssh-key / https-token); same-protocol = replace',
  })
  @ApiCreatedResponse({ type: StoreGitCredentialResponseDto })
  store(@Body() dto: CreateGitCredentialDto): Promise<StoreGitCredentialResult> {
    return this.app.storeGitCredential(dto);
  }

  @Post('git/test')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Test a git credential via ls-remote (15s); inline (test-before-save) or stored; never returns refs',
  })
  @ApiExtraModels(InlineGitTestDto, StoredGitTestDto)
  @ApiBody({
    schema: {
      oneOf: [{ $ref: getSchemaPath(InlineGitTestDto) }, { $ref: getSchemaPath(StoredGitTestDto) }],
      // `mapping` binds each `source` LITERAL to its branch schema so
      // openapi-typescript keeps `source: 'inline' | 'stored'` instead of
      // collapsing it to the schema NAME (the collapse forced a frontend Omit +
      // suppression bridge). Values must match the $ref paths above.
      discriminator: {
        propertyName: 'source',
        mapping: {
          inline: getSchemaPath(InlineGitTestDto),
          stored: getSchemaPath(StoredGitTestDto),
        },
      },
    },
  })
  @ApiOkResponse({ type: GitTestResultResponseDto })
  test(
    @Body(new ZodValidationPipe(GitTestRequestSchema)) dto: GitTestRequestInput,
  ): Promise<GitTestResult> {
    return this.app.testGitCredential(dto);
  }

  @Delete('git/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a git credential (wipes ciphertext, keeps audit metadata)' })
  @ApiNoContentResponse()
  revoke(@Param('id') id: string): Promise<void> {
    return this.app.revokeGitCredential(id);
  }
}
