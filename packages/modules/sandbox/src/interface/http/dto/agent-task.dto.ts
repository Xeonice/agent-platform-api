import { createZodDto } from 'nestjs-zod';
import { AgentTaskDtoSchema, RunAgentTaskSchema } from '@platform/contracts';

/**
 * createZodDto wraps the zod single source (02 §3) so @nestjs/swagger reflects these
 * into openapi.json, and `ZodValidationPipe` enforces them on the wire.
 *
 * ⚠️ THE REQUEST DTO IS WHERE `extraArgs` STAYS A WHITELIST. `RunAgentTaskSchema`
 * declares it as an enum of values the platform understands; validating here means a
 * caller cannot smuggle an arbitrary flag into the CLI's argv, which is the one thing
 * that turns "run this prompt" into "run this command" (task.schema.ts).
 */
export class RunAgentTaskDto extends createZodDto(RunAgentTaskSchema) {}
export class AgentTaskResponseDto extends createZodDto(AgentTaskDtoSchema) {}
