import { createZodDto } from 'nestjs-zod';
import {
  CreateGitCredentialSchema,
  GitTestResultSchema,
  InlineGitTestSchema,
  MaskedGitCredentialSchema,
  StoredGitTestSchema,
  StoreGitCredentialResultSchema,
} from '@platform/contracts';

/** createZodDto wraps the zod single source (02 §3) into Swagger-reflectable DTOs. */
export class CreateGitCredentialDto extends createZodDto(CreateGitCredentialSchema) {}
export class MaskedGitCredentialResponseDto extends createZodDto(MaskedGitCredentialSchema) {}
export class StoreGitCredentialResponseDto extends createZodDto(StoreGitCredentialResultSchema) {}
export class GitTestResultResponseDto extends createZodDto(GitTestResultSchema) {}

// The test body is a discriminated union — a class cannot extend a union type, so
// the two branches are reflected as separate DTOs and combined via `oneOf` on the
// endpoint; runtime validation uses the union schema (a param-level `ZodBodyPipe`,
// which emits the same ErrorEnvelope the global pipe does — see ../zod-body.pipe.ts).
export class InlineGitTestDto extends createZodDto(InlineGitTestSchema) {}
export class StoredGitTestDto extends createZodDto(StoredGitTestSchema) {}
