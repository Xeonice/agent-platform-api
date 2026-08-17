import { createZodDto } from 'nestjs-zod';
import { CreateProjectSchema, DeleteProjectSchema, ProjectDtoSchema } from '@platform/contracts';

/** createZodDto wraps the zod single source (02 §3) into Swagger-reflectable DTOs. */
export class CreateProjectDto extends createZodDto(CreateProjectSchema) {}
export class DeleteProjectDto extends createZodDto(DeleteProjectSchema) {}
export class ProjectResponseDto extends createZodDto(ProjectDtoSchema) {}
