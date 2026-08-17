import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { CreateProjectSchema } from '@platform/contracts';
import type { CreateProjectInput } from '@platform/contracts';
import { ProjectApplicationService } from '../../application/project-application.service';

const IdSchema = z.object({ id: z.string().min(1) });

/**
 * MCP protocol shell for projects (02 §5/§7) — injects the SAME
 * ProjectApplicationService as the REST controller. All @rekog/mcp-nest specifics
 * are confined here.
 */
@Injectable()
export class ProjectMcpTools {
  constructor(private readonly app: ProjectApplicationService) {}

  @Tool({
    name: 'create_project',
    description: 'Create a project (git ⇒ async shallow clone; empty ⇒ ready)',
    parameters: CreateProjectSchema,
  })
  async createProject(params: CreateProjectInput) {
    const dto = await this.app.create(params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(dto) }] };
  }

  @Tool({
    name: 'list_projects',
    description: 'List all projects',
    parameters: z.object({}),
  })
  async listProjects() {
    const dtos = await this.app.list();
    return { content: [{ type: 'text' as const, text: JSON.stringify(dtos) }] };
  }

  @Tool({
    name: 'get_project',
    description: 'Get a project by id',
    parameters: IdSchema,
  })
  async getProject(params: z.infer<typeof IdSchema>) {
    const dto = await this.app.get(params.id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(dto) }] };
  }

  @Tool({
    name: 'retry_clone',
    description: 'Retry a failed project clone',
    parameters: IdSchema,
  })
  async retryClone(params: z.infer<typeof IdSchema>) {
    const dto = await this.app.retryClone(params.id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(dto) }] };
  }

  @Tool({
    name: 'delete_project',
    description: 'Delete a project',
    parameters: IdSchema,
  })
  async deleteProject(params: z.infer<typeof IdSchema>) {
    await this.app.delete(params.id, {});
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ id: params.id, deleted: true }) }],
    };
  }
}
