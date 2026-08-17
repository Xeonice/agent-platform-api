import { Module } from '@nestjs/common';
import { SandboxModule } from '@platform/sandbox';
import { TerminalGateway } from './gateway/terminal.gateway';

/**
 * Terminal context module. Imports SandboxModule to consume the cross-context
 * SANDBOX_PTY_PORT (06 §3) — terminal never touches sandbox internals directly.
 */
@Module({
  imports: [SandboxModule],
  providers: [TerminalGateway],
})
export class TerminalModule {}
