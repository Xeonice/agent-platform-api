import { createZodDto } from 'nestjs-zod';
import { RetainedVolumeDtoSchema } from '@platform/contracts';

/** createZodDto wraps the zod single source (02 §3) into a Swagger-reflectable DTO. */
export class RetainedVolumeResponseDto extends createZodDto(RetainedVolumeDtoSchema) {}
