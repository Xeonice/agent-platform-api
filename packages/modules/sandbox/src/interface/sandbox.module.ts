import { Global, Module } from '@nestjs/common';
import {
  AUTOMATION_TASK_LAUNCHER,
  SANDBOX_EXEC_PORT,
  SANDBOX_PROVIDER_REGISTRY,
  SANDBOX_PTY_PORT,
  SANDBOX_FACADE,
  TASK_EVENT_BROADCASTER,
  TASK_LOG_STORE,
  WORKSPACE_PREPARER,
} from '@platform/contracts';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import { AGENT_TASK_REPOSITORY } from '../domain/repositories/agent-task.repository';
import { SandboxApplicationService } from '../application/sandbox-application.service';
import { AgentTaskApplicationService } from '../application/agent-task.service';
import { RunAgentTaskWorkflow } from '../application/workflows/run-agent-task.workflow';
import { TaskEventHub } from '../application/task-event.hub';
import { SandboxPtyAdapter } from '../application/sandbox-pty.adapter';
import { SandboxExecAdapter } from '../application/sandbox-exec.adapter';
import { ProvisionSandboxWorkflow } from '../application/workflows/provision-sandbox.workflow';
import { SandboxFacadeAdapter } from '../application/sandbox-facade.adapter';
import { AutomationTaskLauncherAdapter } from '../application/automation-task-launcher.adapter';
import { SandboxEventProjector } from '../application/sandbox-event.projector';
import { CredentialRevokedHandler } from '../application/event-handlers/credential-revoked.handler';
import { SqliteSandboxRepository } from '../infrastructure/persistence/sqlite/sandbox.repository.impl';
import { SqliteAgentTaskRepository } from '../infrastructure/persistence/sqlite/agent-task.repository.impl';
import { FsTaskLogStore } from '../infrastructure/tasks/fs-task-log.store';
import { FsWorkspacePreparer } from '../infrastructure/workspace/workspace-preparer';
import { SandboxProviderRegistry } from '../infrastructure/registry/provider-registry';
import { SandboxHealthMonitor } from '../application/sandbox-health.monitor';
import { AioSandboxProvider } from '../infrastructure/providers/aio/aio-sandbox.provider';
import { BoxliteSandboxProvider } from '../infrastructure/providers/boxlite/boxlite-sandbox.provider';
import { DOCKER_CLIENT } from '../infrastructure/providers/docker/docker.token';
import { createDockerClient } from '../infrastructure/providers/docker/docker-client';
import { DockerSelfNetworkCheck } from '../infrastructure/providers/docker/self-network-check.service';
import { RuntimeReconciler } from '../infrastructure/reconcile/runtime-reconciler';
import { SandboxController } from './http/sandbox.controller';
import { AgentTaskController } from './http/agent-task.controller';
import { ProviderController } from './http/provider.controller';
import { TasksGateway } from './gateway/tasks.gateway';
import { SandboxMcpTools } from './mcp/sandbox.mcp-tools';

/**
 * Composition root for the sandbox context — the ONE place ports are wired to
 * implementations (boundaries `module-root` element). Registers BOTH built-in
 * providers (aio default + boxlite) against the open registry, the workspace
 * preparer, and the cross-context SANDBOX_PTY_PORT (consumed by `terminal`) +
 * SANDBOX_FACADE (consumed by `project` for taskCount). @Global so those tokens
 * reach other contexts by token without a package cycle (mirrors ProjectModule).
 *
 * SANDBOX_PROVIDER_REGISTRY is EXPORTED (mirroring RuntimeModule's adapter registry):
 * that is what makes 04 §8 方式一 real — an out-of-tree module can inject the token and
 * `register()` its provider from `onModuleInit` without this file being edited.
 */
@Global()
@Module({
  controllers: [SandboxController, AgentTaskController, ProviderController],
  providers: [
    SandboxApplicationService,
    AgentTaskApplicationService,
    ProvisionSandboxWorkflow,
    RunAgentTaskWorkflow,
    SandboxMcpTools,
    // The gateway SUBSCRIBES to the hub rather than being the broadcaster itself:
    // binding the token straight to the gateway closes gateway → service → workflow →
    // broadcaster into a cycle, and Nest answers that by hanging at boot without an
    // error (see TaskEventHub).
    TaskEventHub,
    TasksGateway,
    { provide: TASK_EVENT_BROADCASTER, useExisting: TaskEventHub },
    { provide: TASK_LOG_STORE, useClass: FsTaskLogStore },
    { provide: SANDBOX_REPOSITORY, useClass: SqliteSandboxRepository },
    { provide: AGENT_TASK_REPOSITORY, useClass: SqliteAgentTaskRepository },
    { provide: WORKSPACE_PREPARER, useClass: FsWorkspacePreparer },
    { provide: DOCKER_CLIENT, useFactory: createDockerClient },
    SandboxHealthMonitor,
    AioSandboxProvider,
    BoxliteSandboxProvider,
    { provide: SANDBOX_PROVIDER_REGISTRY, useClass: SandboxProviderRegistry },
    { provide: SANDBOX_PTY_PORT, useClass: SandboxPtyAdapter },
    { provide: SANDBOX_EXEC_PORT, useClass: SandboxExecAdapter },
    { provide: SANDBOX_FACADE, useClass: SandboxFacadeAdapter },
    // 03 §8.2 行 4：automation 起的必须是**标准**无头 Task —— 这个 adapter 就是那条
    // 「不许绕过」的落点，它内部调的是人手动建 Task 走的同一个 application 方法。
    { provide: AUTOMATION_TASK_LAUNCHER, useClass: AutomationTaskLauncherAdapter },
    RuntimeReconciler,
    // 开机自检：填了 SANDBOX_DOCKER_NETWORK 就证实「我自己也在那个网络里」——
    // 那句声明里唯一填得错的一半（shared/11 §1.4）。没填 = 直接返回。
    DockerSelfNetworkCheck,
    SandboxEventProjector,
    CredentialRevokedHandler,
  ],
  exports: [
    SandboxApplicationService,
    AgentTaskApplicationService,
    SANDBOX_PROVIDER_REGISTRY,
    SANDBOX_PTY_PORT,
    SANDBOX_EXEC_PORT,
    SANDBOX_FACADE,
    AUTOMATION_TASK_LAUNCHER,
  ],
})
export class SandboxModule {}
