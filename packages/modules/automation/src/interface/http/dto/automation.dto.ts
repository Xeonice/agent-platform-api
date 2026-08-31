import { createZodDto } from 'nestjs-zod';
import {
  AutomationDtoSchema,
  AutomationRunDtoSchema,
  CreateAutomationSchema,
  PaginatedAutomationRunsSchema,
  UpdateAutomationSchema,
  WebhookTestResultSchema,
  WebhookTestSchema,
} from '@platform/contracts';

/** createZodDto wraps the zod single source (02 §3) into Swagger-reflectable DTOs. */
export class CreateAutomationDto extends createZodDto(CreateAutomationSchema) {}
export class UpdateAutomationDto extends createZodDto(UpdateAutomationSchema) {}
export class AutomationResponseDto extends createZodDto(AutomationDtoSchema) {}
export class AutomationRunResponseDto extends createZodDto(AutomationRunDtoSchema) {}
export class PaginatedAutomationRunsDto extends createZodDto(PaginatedAutomationRunsSchema) {}
export class WebhookTestRequestDto extends createZodDto(WebhookTestSchema) {}
export class WebhookTestResultDto extends createZodDto(WebhookTestResultSchema) {}
