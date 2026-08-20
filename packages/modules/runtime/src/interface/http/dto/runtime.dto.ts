import { createZodDto } from 'nestjs-zod';
import {
  AuthChallengeSchema,
  AuthStatusResultSchema,
  BeginAuthRequestSchema,
  CompleteAuthRequestSchema,
  MaskedCredentialResultSchema,
  RuntimeDtoSchema,
  RuntimeSettingsDtoSchema,
  SetAuthModeRequestSchema,
  SubmitSecretRequestSchema,
} from '@platform/contracts';

/** createZodDto wraps the runtime zod single source (05, 27 §4) into Swagger DTOs. */
export class RuntimeResponseDto extends createZodDto(RuntimeDtoSchema) {}
export class AuthChallengeResponseDto extends createZodDto(AuthChallengeSchema) {}
export class AuthStatusResultResponseDto extends createZodDto(AuthStatusResultSchema) {}
export class MaskedCredentialResultResponseDto extends createZodDto(MaskedCredentialResultSchema) {}
export class RuntimeSettingsResponseDto extends createZodDto(RuntimeSettingsDtoSchema) {}

export class BeginAuthDto extends createZodDto(BeginAuthRequestSchema) {}
export class CompleteAuthDto extends createZodDto(CompleteAuthRequestSchema) {}
export class SubmitSecretDto extends createZodDto(SubmitSecretRequestSchema) {}
export class SetAuthModeDto extends createZodDto(SetAuthModeRequestSchema) {}
