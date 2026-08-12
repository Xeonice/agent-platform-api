import { createZodDto } from 'nestjs-zod';
import {
  CreateSandboxSchema,
  ListSandboxesQuerySchema,
  SandboxDtoSchema,
} from '@platform/contracts';

/**
 * createZodDto wraps the zod single source (02 §3) into class DTOs so
 * @nestjs/swagger reflects them into openapi.json. patchNestJsSwagger() (called
 * at bootstrap) teaches Swagger to read zod enums/unions faithfully (P1-4).
 */
export class CreateSandboxDto extends createZodDto(CreateSandboxSchema) {}
export class ListSandboxesQueryDto extends createZodDto(ListSandboxesQuerySchema) {}
export class SandboxResponseDto extends createZodDto(SandboxDtoSchema) {}
