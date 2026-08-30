import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import {
  CreateSandboxSchema,
  DestroySandboxSchema,
  ExecInSandboxSchema,
  ListSandboxesQuerySchema,
  RunAgentTaskSchema,
} from '@platform/contracts';
import type { CreateSandboxInput, ListSandboxesQuery } from '@platform/contracts';
import { SandboxApplicationService } from '../../application/sandbox-application.service';
import { AgentTaskApplicationService } from '../../application/agent-task.service';

const DestroySandboxToolSchema = DestroySandboxSchema.extend({ id: z.string().min(1) });

/**
 * The three lifecycle/read tools take nothing but the id, so they get one shared shape
 * rather than three identical inline objects — a divergence between them (one accepting
 * an empty string, say) would be a difference with no meaning behind it.
 */
const SandboxIdToolSchema = z.object({ id: z.string().min(1) });

/**
 * `exec_in_sandbox` input = the REST body plus the path parameter, so the two shells
 * validate the SAME `ExecInSandboxSchema` (02 §5 zod 单源).
 *
 * ⚠️ THIS IS THE SECOND TOOL THAT LETS AN OUTSIDE CALLER RUN SOMETHING, and unlike
 * `run_agent_task` it has no whitelist to hide behind — the command is free text by
 * design (10 §7.3 `ExecRequest { command }`). What bounds it is the SANDBOX: the
 * command runs inside the isolated instance, never on the host, which is the same
 * boundary the terminal has relied on since day one. The alternative — omitting the
 * tool — would only push callers to `run_agent_task` with a prompt that says "run this
 * command", i.e. the same capability with worse observability.
 */
const ExecInSandboxToolSchema = ExecInSandboxSchema.extend({ id: z.string().min(1) });

/**
 * `run_agent_task` input = the REST body plus the two path parameters, so the MCP and
 * REST shells validate the SAME `RunAgentTaskSchema` (02 §5) — including the
 * `extraArgs` WHITELIST, which is the point: this is the first tool that lets an
 * outside caller execute something, and a second entry point with looser validation
 * would make the whitelist decorative.
 */
const RunAgentTaskToolSchema = RunAgentTaskSchema.extend({
  sandboxId: z.string().min(1),
  runtime: z.string().min(1),
});

/**
 * ⚠️ A tool that STARTS work without a tool that STOPS it is half an API. An upper-layer
 * agent that fires a 4-hour Task and then decides otherwise would have no recourse but
 * the hard timeout — and unlike a human it has no browser tab to close.
 */
const CancelAgentTaskToolSchema = z.object({
  sandboxId: z.string().min(1),
  taskId: z.string().min(1),
});

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
  constructor(
    private readonly app: SandboxApplicationService,
    private readonly tasks: AgentTaskApplicationService,
  ) {}

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

  /**
   * The headless Task entry point for an upper-layer agent (P20 §9.4). It returns as
   * soon as the job is RUNNING — a Task may run for hours, so the tool answers with an
   * id and the caller polls `GET /api/sandboxes/:id/tasks/:taskId` or subscribes to the
   * `/tasks` channel; blocking an MCP call for four hours is not an option.
   */
  @Tool({
    name: 'run_agent_task',
    description:
      'Start a headless agent Task in a sandbox and return its id immediately (202-style). ' +
      'Poll the task or subscribe to the /tasks channel for output.',
    parameters: RunAgentTaskToolSchema,
  })
  async runAgentTask(params: z.infer<typeof RunAgentTaskToolSchema>) {
    const { sandboxId, runtime, ...input } = params;
    const dto = await this.tasks.run(sandboxId, runtime, input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(dto) }] };
  }

  @Tool({
    name: 'cancel_agent_task',
    description:
      'Ask a running headless agent Task to stop (SIGTERM, escalating to SIGKILL after ' +
      '5s). Returns immediately; the terminal state follows on the task.',
    parameters: CancelAgentTaskToolSchema,
  })
  async cancelAgentTask(params: z.infer<typeof CancelAgentTaskToolSchema>) {
    const dto = await this.tasks.cancel(params.sandboxId, params.taskId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(dto) }] };
  }

  @Tool({
    name: 'get_sandbox',
    description: 'Get one sandbox (Task) by id, including why it failed if it did',
    parameters: SandboxIdToolSchema,
  })
  async getSandbox(params: z.infer<typeof SandboxIdToolSchema>) {
    const dto = await this.app.get(params.id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(dto) }] };
  }

  /**
   * ⚠️ `start_sandbox` RETURNS BEFORE THE SANDBOX IS USABLE, and the description says so
   * because an LLM caller has no other way to find out. A restart re-runs the whole
   * `starting` 段 (03 §4.3) — measured at minutes on a cold image store — so the tool
   * answers with the accepted `starting` state and the caller polls `get_sandbox`,
   * exactly like `create_project` / `list_projects` handle an async clone.
   */
  @Tool({
    name: 'start_sandbox',
    description:
      'Start a stopped sandbox. Returns immediately with status `starting`; poll ' +
      'get_sandbox until it reads `running`. A restart is a NEW agent session — the ' +
      'previous conversation context is gone, the workspace files are not.',
    parameters: SandboxIdToolSchema,
  })
  async startSandbox(params: z.infer<typeof SandboxIdToolSchema>) {
    const dto = await this.app.start(params.id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(dto) }] };
  }

  @Tool({
    name: 'stop_sandbox',
    description:
      'Stop a running sandbox, keeping its instance and workspace so start_sandbox can ' +
      'bring it back. Use destroy_sandbox to remove it entirely.',
    parameters: SandboxIdToolSchema,
  })
  async stopSandbox(params: z.infer<typeof SandboxIdToolSchema>) {
    const dto = await this.app.stop(params.id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(dto) }] };
  }

  @Tool({
    name: 'exec_in_sandbox',
    description:
      'Run ONE non-interactive shell command inside a running sandbox and return its ' +
      'stdout/stderr/exitCode. Not for interactive programs and not for long jobs — ' +
      'it is cut off after 60s; use run_agent_task for anything longer.',
    parameters: ExecInSandboxToolSchema,
  })
  async execInSandbox(params: z.infer<typeof ExecInSandboxToolSchema>) {
    const { id, ...input } = params;
    const result = await this.app.exec(id, input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  }

  @Tool({
    name: 'destroy_sandbox',
    description: 'Destroy a sandbox by id (optionally keeping its workspace)',
    parameters: DestroySandboxToolSchema,
  })
  async destroySandbox(params: z.infer<typeof DestroySandboxToolSchema>) {
    await this.app.destroy(params.id, { keepVolume: params.keepVolume });
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ id: params.id, destroyed: true }) },
      ],
    };
  }
}
