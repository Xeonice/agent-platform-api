import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { CreateSandboxSchema, ListSandboxesQuerySchema } from '@platform/contracts';
import type { CreateSandboxInput, ListSandboxesQuery } from '@platform/contracts';
import { SandboxApplicationService } from '../../application/sandbox-application.service';

/**
 * MCP protocol shell (02 §5). It injects the SAME SandboxApplicationService as
 * the REST controller — proving the double-protocol design: one application,
 * two thin shells. @Tool `parameters` reuse the exact same zod schema as REST.
 *
 * All @rekog/mcp-nest specifics are confined to this one file (02 §7): if the
 * community lib is dropped, only this shell is rewritten — application/domain
 * are untouched.
 */
@Injectable()
export class SandboxMcpTools {
  constructor(private readonly app: SandboxApplicationService) {}

  @Tool({
    name: 'create_sandbox',
    description: 'Create a new agent sandbox (Task)',
    parameters: CreateSandboxSchema,
  })
  async createSandbox(params: CreateSandboxInput) {
    const dto = await this.app.create(params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(dto) }] };
  }

  @Tool({
    name: 'list_sandboxes',
    description: 'List sandboxes, optionally filtered by projectId',
    parameters: ListSandboxesQuerySchema,
  })
  async listSandboxes(params: ListSandboxesQuery) {
    const dtos = await this.app.list(params.projectId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(dtos) }] };
  }
}
