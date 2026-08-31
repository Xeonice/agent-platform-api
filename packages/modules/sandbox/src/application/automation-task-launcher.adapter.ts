import { HttpException, Inject, Injectable } from '@nestjs/common';
import { asSandboxId } from '@platform/shared-kernel';
import {
  AutomationResourceExhausted,
  SandboxProviderError,
  SandboxProviderErrorCode,
} from '@platform/contracts';
import type {
  AutomationTaskLauncher,
  AutomationTaskLaunchInput,
  AutomationTaskPhase,
} from '@platform/contracts';
import { SandboxApplicationService } from './sandbox-application.service';
import { AgentTaskApplicationService } from './agent-task.service';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../domain/repositories/sandbox.repository';
import { AGENT_TASK_REPOSITORY } from '../domain/repositories/agent-task.repository';
import type { AgentTaskRepository } from '../domain/repositories/agent-task.repository';
import type { AgentTask } from '../domain/entities/agent-task.entity';

/**
 * `AUTOMATION_TASK_LAUNCHER` 的实现（contracts 口，automation 上下文消费）。
 *
 * ⛔ **它不是一条捷径。** 03 §8.2 行 4 与 P21-7 §9 要求自动化触发的必须是**标准无头
 * Task** —— 同状态机、同配额登记、同独立副本。所以 `createSandbox` 调的就是
 * `SandboxApplicationService.create`（人手动建 Task 走的那一个，连创建门的七条校验
 * 都一并经过），`startTask` 调的就是 `AgentTaskApplicationService.run`
 * （`POST /api/sandboxes/:id/runtimes/:rt/tasks` 背后的那一个）。
 *
 * ★ **为什么是两步而不是一步**：`headless:true` 的沙箱**不会**自己起 agent 会话
 * （`ProvisionSandboxWorkflow.bootstrapAgentSession` 第一行就 `if (sandbox.headless) return`
 * ——那是 T-4 的定案），而 `run()` 又要求沙箱已经 `running`。中间那段是分钟级的
 * （boxlite 冷拉 ~220s、冷装 CLI 实测 753s）。把它做成「创建 → 每分钟看一眼相位 →
 * ready 了再 POST」，整条链路的状态全在库里，进程重启接着走。
 */
@Injectable()
export class AutomationTaskLauncherAdapter implements AutomationTaskLauncher {
  constructor(
    private readonly sandboxes: SandboxApplicationService,
    private readonly tasks: AgentTaskApplicationService,
    @Inject(SANDBOX_REPOSITORY) private readonly repo: SandboxRepository,
    @Inject(AGENT_TASK_REPOSITORY) private readonly taskRepo: AgentTaskRepository,
  ) {}

  async createSandbox(input: AutomationTaskLaunchInput): Promise<{ sandboxId: string }> {
    try {
      const dto = await this.sandboxes.create({
        projectId: input.projectId,
        runtime: input.runtimeId,
        headless: true,
        timeoutMinutes: input.timeoutMinutes,
        // ⚠️ **prompt 同时落 `initial_prompt`**：headless 路径不消费它（见上），但它是
        // 这一发到底要跑什么的**唯一落库副本**，排障时没有它就只能去猜。
        initialPrompt: input.prompt,
      });
      return { sandboxId: dto.id };
    } catch (e) {
      throw this.asResourceSignal(e);
    }
  }

  async startTask(sandboxId: string, input: AutomationTaskLaunchInput): Promise<void> {
    try {
      await this.tasks.run(sandboxId, input.runtimeId, {
        prompt: input.prompt,
        timeoutMinutes: input.timeoutMinutes,
      });
    } catch (e) {
      throw this.asResourceSignal(e);
    }
  }

  /**
   * 每轮扫描的观测点。**永不抛**：一条查不到的沙箱是 `gone`，不是一个能把整轮扫描
   * 打断的异常。
   */
  async phaseOf(sandboxId: string): Promise<AutomationTaskPhase> {
    const sandbox = await this.repo.findById(asSandboxId(sandboxId));
    if (!sandbox) return { kind: 'gone' };

    const latest = await this.latestTask(sandboxId);
    if (latest !== null && !latest.isRunning) return this.finished(latest);

    switch (sandbox.status) {
      case 'pending':
      case 'scheduling':
      case 'preparing-workspace':
      case 'creating':
      case 'starting':
        return { kind: 'provisioning' };
      case 'running':
      case 'idle':
        // 沙箱起来了：还没起 Task ⇒ 该 POST 了；起了且在飞 ⇒ 等。
        return latest === null ? { kind: 'ready' } : { kind: 'running' };
      case 'failed':
        return {
          kind: 'finished',
          status: 'failed',
          errorMessage: sandbox.failureReason ?? 'sandbox failed before the task could run',
        };
      case 'stopping':
      case 'stopped':
      case 'destroying':
      case 'destroyed':
        // 没有任何 Task 记录、沙箱又已经在下线 —— 这一发再也不会有结果了。
        return { kind: 'gone' };
    }
  }

  private finished(task: AgentTask): AutomationTaskPhase {
    const status =
      task.status === 'succeeded' ? 'success' : task.status === 'timed_out' ? 'timeout' : 'failed';
    return {
      kind: 'finished',
      status,
      ...(task.errorCode !== null ? { errorMessage: task.errorCode } : {}),
      // ⚠️ 指向 **Task 自己的那份 stdout**，不复制（03 §8.6「正文只写一份」）。
      logPath: `${task.logPath}/stdout.jsonl`,
      logBytes: task.stdoutBytes,
    };
  }

  private async latestTask(sandboxId: string): Promise<AgentTask | null> {
    const rows = await this.taskRepo.findBySandbox(asSandboxId(sandboxId));
    if (rows.length === 0) return null;
    return rows.reduce((a, b) => (b.startedAt.getTime() >= a.startedAt.getTime() ? b : a));
  }

  /**
   * 把「没资源了」从一堆异常里认出来（决策表行 3）。
   *
   * ⚠️ 两种抛法都要认：创建门会把 `SandboxProviderError` 映射成 429 的 `HttpException`
   * （`create-door.spec.ts` 有这条），而更下层直接抛的是 `SandboxProviderError` 本身。
   * 只认其中一种，行 3 就会在另一半路径上退化成「记一次失败」——而那会污染
   * `consecutive_failures`，最终把一条只是排队等资源的规则自动禁用掉。
   */
  private asResourceSignal(e: unknown): unknown {
    if (
      e instanceof SandboxProviderError &&
      e.code === SandboxProviderErrorCode.RESOURCE_EXHAUSTED
    ) {
      return new AutomationResourceExhausted(e.message);
    }
    if (e instanceof HttpException) {
      const body = e.getResponse();
      if (typeof body === 'object' && body !== null && 'code' in body) {
        const code = (body as { code?: unknown }).code;
        if (code === SandboxProviderErrorCode.RESOURCE_EXHAUSTED) {
          return new AutomationResourceExhausted(e.message);
        }
      }
    }
    return e;
  }
}
