import { Global, Module } from '@nestjs/common';
import { AGENT_SESSION_BOOTSTRAP } from '@platform/contracts';
import { SandboxModule } from '@platform/sandbox';
import { TerminalSessionService } from '../application/terminal-session.service';
import { TerminalGateway } from './gateway/terminal.gateway';

/**
 * Terminal context module. Imports SandboxModule to consume the cross-context
 * SANDBOX_PTY_PORT / SANDBOX_EXEC_PORT (06 §3) — terminal never touches sandbox
 * internals directly.
 *
 * @Global + exporting `AGENT_SESSION_BOOTSTRAP` is what lets the sandbox provision
 * workflow call `bootstrapAgentSession` (23 §10.4, the sanctioned reverse direction)
 * WITHOUT `sandbox` importing `@platform/terminal` — the coupling stays a contracts
 * token, so the package dependency graph keeps its single direction and no cycle
 * appears at either the module or the package level.
 */
@Global()
@Module({
  imports: [SandboxModule],
  providers: [
    TerminalSessionService,
    TerminalGateway,
    { provide: AGENT_SESSION_BOOTSTRAP, useExisting: TerminalSessionService },
  ],
  exports: [AGENT_SESSION_BOOTSTRAP],
})
export class TerminalModule {}
