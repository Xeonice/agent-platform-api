import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type {
  CheckImageUpdateDto,
  ImageManifestDto,
  RegisterImageResultDto,
  RevalidateOutcomeDto,
  ValidationOutcomeDto,
} from '@platform/contracts';
import { ImageApplicationService } from '../../application/image-application.service';
import {
  CheckImageUpdateResponseDto,
  ImageManifestResponseDto,
  PatchImageDto,
  RegisterImageDto,
  RegisterImageResponseDto,
  RevalidateOutcomeResponseDto,
  ValidationOutcomeResponseDto,
} from './dto/image.dto';
import { mapImageErrors } from '../../application/image-error.http';

/** The minimum of an express `Response` this controller needs (no `express` dep). */
interface StatusSettable {
  status(code: number): unknown;
}

/**
 * REST protocol shell for the image context (02 §5.1, 27 §6, shared/10 §6.4).
 * Eight endpoints, REST-ONLY — none of them is registered to MCP (27 §6 「MCP: —」).
 */
@ApiTags('image')
@Controller('images')
export class ImageController {
  constructor(private readonly app: ImageApplicationService) {}

  @Get()
  @ApiOperation({
    summary:
      'List image manifests. `runtimeId` filters to the wizard-selectable set ' +
      '(is_active ∧ not invalid ∧ supports that runtime); without it the management ' +
      'page gets history too.',
  })
  @ApiQuery({ name: 'runtimeId', required: false })
  @ApiOkResponse({ type: ImageManifestResponseDto, isArray: true })
  list(@Query('runtimeId') runtimeId?: string): Promise<ImageManifestDto[]> {
    return mapImageErrors(() => this.app.listImages(runtimeId));
  }

  /**
   * ⚠️ 200 vs 201 IS THE IDEMPOTENCY ANSWER, NOT A COSMETIC DETAIL (27 §6). Re-pasting
   * a URI whose digest is already on file returns the EXISTING row with 200 and does
   * not touch its `isActive`; a new digest INSERTs a row and answers 201. Deliberately
   * never 409 — that would send the user to delete-and-recreate, and delete is blocked
   * by RESTRICT the moment any Task has used the image.
   */
  @Post()
  @ApiOperation({ summary: 'Register an image: resolve → validate → freeze the digest' })
  @ApiOkResponse({ type: RegisterImageResponseDto, description: 'this digest was already known' })
  @ApiCreatedResponse({ type: RegisterImageResponseDto, description: 'a new manifest row' })
  async register(
    @Body() dto: RegisterImageDto,
    @Res({ passthrough: true }) res: StatusSettable,
  ): Promise<RegisterImageResultDto> {
    const result = await mapImageErrors(() => this.app.registerImage(dto.ref));
    res.status(result.created ? 201 : 200);
    // `created` stays OFF the wire: the status code already carries it, and an
    // undocumented extra field is a second source for the same fact.
    return { manifest: result.manifest, validation: result.validation };
  }

  /**
   * Pre-flight (审计 P1-3): the 「提交 URI → 分级反馈」 step of the wizard. Resolves and
   * judges but stores NOTHING — distinct from `/:id/validate`, which re-validates an
   * already registered row.
   */
  @Post('validate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Pre-flight validate a reference — never persists a manifest' })
  @ApiOkResponse({ type: ValidationOutcomeResponseDto })
  validate(@Body() dto: RegisterImageDto): Promise<ValidationOutcomeDto> {
    return mapImageErrors(() => this.app.validateImage(dto.ref));
  }

  @Post(':id/validate')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Re-validate a registered manifest (04 §7 时刻②). A digest change is reported ' +
      'old → new — it is a coordinate migration, not a 「refresh succeeded」.',
  })
  @ApiOkResponse({ type: RevalidateOutcomeResponseDto })
  revalidate(@Param('id') id: string): Promise<RevalidateOutcomeDto> {
    return mapImageErrors(() => this.app.revalidateImage(id));
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update the two mutable fields (isActive:false | imageConfig). `isActive:true` ' +
      'is refused with 400 pointing at /activate.',
  })
  @ApiOkResponse({ type: ImageManifestResponseDto })
  patch(@Param('id') id: string, @Body() dto: PatchImageDto): Promise<ImageManifestDto> {
    return mapImageErrors(() => this.app.patchImage(id, dto));
  }

  @Post(':id/activate')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Make this row the current version of its tag — the same action for ' +
      '「更新到新版本」 and 「回滚到旧版本」, in one transaction.',
  })
  @ApiOkResponse({ type: ImageManifestResponseDto })
  activate(@Param('id') id: string): Promise<ImageManifestDto> {
    return mapImageErrors(() => this.app.activateImage(id));
  }

  @Post(':id/check-update')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Re-resolve this row’s tag and compare digests. Stores nothing; 409 when ' +
      'the row is pinned by digest (no tag to re-resolve).',
  })
  @ApiOkResponse({ type: CheckImageUpdateResponseDto })
  checkUpdate(@Param('id') id: string): Promise<CheckImageUpdateDto> {
    return mapImageErrors(() => this.app.checkImageUpdate(id));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Hard-delete a manifest row; 409 when referenced or built-in' })
  @ApiNoContentResponse()
  remove(@Param('id') id: string): Promise<void> {
    return mapImageErrors(() => this.app.deleteImage(id));
  }
}
