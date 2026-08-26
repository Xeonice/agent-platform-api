import { createZodDto } from 'nestjs-zod';
import {
  CheckImageUpdateSchema,
  ImageManifestSchema,
  PatchImageSchema,
  RegisterImageResultSchema,
  RegisterImageSchema,
  RevalidateOutcomeSchema,
  ValidationOutcomeSchema,
} from '@platform/contracts';

/** createZodDto wraps the zod single source (02 §3) into Swagger-reflectable DTOs. */
export class RegisterImageDto extends createZodDto(RegisterImageSchema) {}
export class PatchImageDto extends createZodDto(PatchImageSchema) {}
export class ImageManifestResponseDto extends createZodDto(ImageManifestSchema) {}
export class ValidationOutcomeResponseDto extends createZodDto(ValidationOutcomeSchema) {}
export class RevalidateOutcomeResponseDto extends createZodDto(RevalidateOutcomeSchema) {}
export class CheckImageUpdateResponseDto extends createZodDto(CheckImageUpdateSchema) {}

/** `POST /api/images` returns the row PLUS the verdict that let it in (27 §6). */
export class RegisterImageResponseDto extends createZodDto(RegisterImageResultSchema) {}
