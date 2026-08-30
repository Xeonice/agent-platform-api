import { createZodDto } from 'nestjs-zod';
import {
  CreateSandboxSchema,
  DestroySandboxSchema,
  ExecInSandboxSchema,
  ExecResultSchema,
  ListSandboxesQuerySchema,
  ProviderDtoSchema,
  SandboxDtoSchema,
} from '@platform/contracts';

/**
 * createZodDto wraps the zod single source (02 §3) into class DTOs so
 * @nestjs/swagger reflects them into openapi.json. patchNestJsSwagger() (called
 * at bootstrap) teaches Swagger to read zod enums/unions faithfully (P1-4).
 */
export class CreateSandboxDto extends createZodDto(CreateSandboxSchema) {}
export class ListSandboxesQueryDto extends createZodDto(ListSandboxesQuerySchema) {}
export class DestroySandboxDto extends createZodDto(DestroySandboxSchema) {}
export class SandboxResponseDto extends createZodDto(SandboxDtoSchema) {}
export class ExecInSandboxDto extends createZodDto(ExecInSandboxSchema) {}
export class ExecResultResponseDto extends createZodDto(ExecResultSchema) {}
export class ProviderResponseDto extends createZodDto(ProviderDtoSchema) {}
