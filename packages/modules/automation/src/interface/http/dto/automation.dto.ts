import { createZodDto } from 'nestjs-zod';
import {
  AutomationAttentionItemSchema,
  AutomationDtoSchema,
  AutomationDeletionPreviewDtoSchema,
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
export class AutomationDeletionPreviewResponseDto extends createZodDto(
  AutomationDeletionPreviewDtoSchema,
) {}
export class AutomationAttentionItemResponseDto extends createZodDto(
  AutomationAttentionItemSchema,
) {}
export class AutomationRunResponseDto extends createZodDto(AutomationRunDtoSchema) {}
export class PaginatedAutomationRunsDto extends createZodDto(PaginatedAutomationRunsSchema) {}
export class WebhookTestRequestDto extends createZodDto(WebhookTestSchema) {}
export class WebhookTestResultDto extends createZodDto(WebhookTestResultSchema) {}
