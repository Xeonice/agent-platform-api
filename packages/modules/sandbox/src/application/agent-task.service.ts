import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { asAgentTaskId, asSandboxId } from '@platform/shared-kernel';
import {
  RUNTIME_ADAPTER_REGISTRY,
  SANDBOX_PROVIDER_REGISTRY,
  SandboxProviderError,
  SandboxProviderErrorCode,
} from '@platform/contracts';
import type {
  AgentTaskDto,
  ProviderRegistry,
  RunAgentTaskInput,
  RuntimeAdapterRegistry,
  RuntimeEvent,
  SandboxFiles,
  SandboxHandle,
} from '@platform/contracts';
import { AGENT_TASK_REPOSITORY } from '../domain/repositories/agent-task.repository';
import type { AgentTaskRepository } from '../domain/repositories/agent-task.repository';
import { SANDBOX_REPOSITORY } from '../domain/repositories/sandbox.repository';
import type { SandboxRepository } from '../domain/repositories/sandbox.repository';
import type { AgentTask } from '../domain/entities/agent-task.entity';
import type { Sandbox } from '../domain/entities/sandbox.entity';
import {
  RunAgentTaskWorkflow,
  TASK_ARTIFACT_DIR,
  handleOf,
} from './workflows/run-agent-task.workflow';
import { AgentTaskMapper } from './dto/agent-task.mapper';
import { mapProviderErrorToHttp } from './provider-error.http';

/** Default hard-timeout tier when the caller does not pick one (13 §2.1 / P20 §0). */
const DEFAULT_TIMEOUT_MINUTES = 30;
/** Only these two states have a live instance to run anything in. */
const RUNNABLE_STATES = new Set(['running', 'idle']);

export interface OpenedArtifact {
  name: string;
  stream: NodeJS.ReadableStream;
  /**
   * Total bytes, when the platform can state it WITHOUT GUESSING — `undefined` the rest
   * of the time. See `measureArtifact` for why "the rest of the time" is a real set and
   * why answering `0` into it would be the worst possible failure.
   */
  size?: number;
}

/**
 * Protocol-agnostic application service for headless Tasks (02 §1) — the REST
 * controller, the MCP tool and the `/tasks` gateway all inject THIS.
 *
 * ⚠️ IT IS THE PLATFORM'S FIRST EXTERNALLY-TRIGGERED EXECUTION PATH. Everything
 * before S6 could only create, list and destroy sandboxes; from here an API caller
 * can make an agent RUN. That is why the admission checks below are explicit and why
 * `extraArgs` stays a whitelist all the way down rather than being widened to a free
 * array somewhere in the middle — argv is fully visible inside the sandbox
 * (`/proc/<pid>/cmdline`), and anything appended to it executes.
 */
@Injectable()
export class AgentTaskApplicationService implements OnApplicationBootstrap {
  constructor(
    @Inject(AGENT_TASK_REPOSITORY) private readonly tasks: AgentTaskRepository,
    @Inject(SANDBOX_REPOSITORY) private readonly sandboxes: SandboxRepository,
    @Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry,
    @Inject(RUNTIME_ADAPTER_REGISTRY) private readonly runtimes: RuntimeAdapterRegistry,
    private readonly workflow: RunAgentTaskWorkflow,
  ) {}

  /**
   * Re-attach to jobs a previous process left running (13 §4's discipline, applied to
   * Tasks). Gated by the same env flag as the sandbox reconciler so it never fires in
   * the many throwaway apps a test suite boots against fresh `:memory:` databases —
   * where every row would look like an orphan.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.SANDBOX_RECONCILE_ON_BOOT !== 'true') return;
    await this.resumeRunning().catch(() => undefined);
  }

  /** Public so an operator — or a restart test — can trigger recovery explicitly. */
  resumeRunning(): Promise<number> {
    return this.workflow.resumeRunning();
  }

  /**
   * `POST /api/sandboxes/:id/runtimes/:rt/tasks` — accept and return 202.
   *
   * The job is already RUNNING when this resolves (that is what makes the taskId
   * meaningful), but nothing is waited on beyond acceptance: a Task runs for up to
   * four hours.
   */
  async run(sandboxId: string, runtimeId: string, input: RunAgentTaskInput): Promise<AgentTaskDto> {
    try {
      const sandbox = await this.requireSandbox(sandboxId);
      this.assertRunnable(sandbox, runtimeId);
      const task = await this.workflow.start(sandbox, {
        sandboxId,
        runtime: runtimeId,
        prompt: input.prompt,
        timeoutMinutes: input.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
        resumeFrom: input.resumeFrom,
        // Already narrowed to the `TaskExtraArgSchema` enum by validation; passing the
        // values through unchanged is the point — this is the LAST place they could be
        // widened, and they are not.
        extraArgs: input.extraArgs,
      });
      return AgentTaskMapper.toDto(task);
    } catch (e) {
      throw mapProviderErrorToHttp(e);
    }
  }

  /** `GET /api/sandboxes/:id/tasks/:taskId`. */
  async get(sandboxId: string, taskId: string): Promise<AgentTaskDto> {
    return AgentTaskMapper.toDto(await this.requireTask(sandboxId, taskId));
  }

  /**
   * `GET /api/sandboxes/:id/tasks` — every Task ever run in a sandbox, NEWEST FIRST.
   *
   * It is not a convenience listing. After a reload the frontend has no other source
   * for "which run was I watching": a `taskId` it stashed locally is a guess, not an
   * authority, and a sandbox that has run several turns has several. This endpoint is
   * the authority, and it is also what makes more than one concurrent run expressible
   * later without another round of protocol work.
   */
  async listBySandbox(sandboxId: string): Promise<AgentTaskDto[]> {
    await this.requireSandbox(sandboxId);
    const rows = await this.tasks.findBySandbox(asSandboxId(sandboxId));
    return rows
      .slice()
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .map((t) => AgentTaskMapper.toDto(t));
  }

  /**
   * `POST /api/sandboxes/:id/tasks/:taskId/cancel` — stop a run on request, 202.
   *
   * ⚠️ THIS EXISTS BECAUSE THE PLATFORM WOULD OTHERWISE HAVE NO STOP BUTTON. `killJob`
   * was reachable only from the hard-timeout backstop, so a user who started a 4-hour
   * run and changed their mind had exactly one option: wait four hours. Opening
   * execution to callers without also opening termination is half a feature.
   *
   * It returns as soon as the signal is on its way. The TERMINAL state arrives through
   * the normal path — the pump sees the job exit, collects artifacts, records `killed`
   * and only then releases — because two code paths racing to finalise the same task is
   * how a job gets released before its exit code was read.
   */
  async cancel(sandboxId: string, taskId: string): Promise<AgentTaskDto> {
    const task = await this.requireTask(sandboxId, taskId);
    if (!task.isRunning) {
      throw mapProviderErrorToHttp(
        new SandboxProviderError(
          SandboxProviderErrorCode.INVALID_STATE,
          `task ${taskId} already finished as '${task.status}'`,
        ),
      );
    }
    const sandbox = await this.requireSandbox(sandboxId);
    try {
      await this.workflow.cancel(task, sandbox);
      return AgentTaskMapper.toDto(task);
    } catch (e) {
      throw mapProviderErrorToHttp(e);
    }
  }

  /**
   * `GET /api/sandboxes/:id/tasks/:taskId/artifacts/:name` — stream one artifact out
   * of the sandbox.
   *
   * ── Two independent guards, because this resolves a caller-supplied name into a
   *    path inside someone else's filesystem ────────────────────────────────────────
   *   ① the name must be RELATIVE and free of `..` segments, so it cannot climb out of
   *      the drop box into the workspace (or into `~/.codex/auth.json`);
   *   ② once the Task has finished, the name must additionally be one the platform
   *      actually RECORDED. Before that the listing does not exist yet, so ① stands
   *      alone — which is why ① is a real check and not a formality.
   *
   * It also reports the artifact's SIZE when it can honestly know it, so the download
   * can carry a `content-length` and the browser can draw a progress bar. `undefined`
   * whenever it cannot — see `measureArtifact`.
   */
  async openArtifact(sandboxId: string, taskId: string, name: string): Promise<OpenedArtifact> {
    const task = await this.requireTask(sandboxId, taskId);
    const safe = sanitizeArtifactName(name);
    if (safe === null) {
      throw new HttpException(
        { code: 'INVALID_ARTIFACT_NAME', message: `'${name}' is not a valid artifact name` },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (task.artifacts.length > 0 && !task.artifacts.some((a) => a.name === safe)) {
      throw new NotFoundException(`task ${taskId} has no artifact '${safe}'`);
    }
    const sandbox = await this.requireSandbox(sandboxId);
    try {
      const provider = this.providers.get(sandbox.provider);
      const files = provider.files;
      if (!files) {
        throw new SandboxProviderError(
          SandboxProviderErrorCode.UNSUPPORTED_CAPABILITY,
          `provider '${provider.name}' has no file plane to read artifacts from`,
        );
      }
      const handle = handleOf(sandbox);
      const path = `${TASK_ARTIFACT_DIR}/${safe}`;
      // measured BEFORE the stream is opened, so the number describes the file the
      // stream is about to read rather than one that has since been replaced.
      const size = await this.measureArtifact(task, files, handle, path);
      const stream = await files.openFileStream(handle, path);
      // `null` is the file plane saying "not there" — a normal answer, not a fault.
      if (!stream) throw new NotFoundException(`artifact '${safe}' is not in the sandbox`);
      return { name: safe, stream, ...(size !== undefined ? { size } : {}) };
    } catch (e) {
      throw mapProviderErrorToHttp(e);
    }
  }

  /**
   * How many bytes the download is about to be — or `undefined`, which is a real and
   * frequent answer rather than a fallback nobody hits.
   *
   * ── Why NOT `task.artifacts[].size`, which is already in hand ─────────────────────
   * That number was measured when the run ENDED, and it is stored as `e.size ?? 0`:
   * a file whose size the agent declined to report is indistinguishable there from an
   * empty one. Sending `content-length: 0` for a 4 MB artifact is the single worst
   * outcome available — the browser stops reading at zero and writes an empty file,
   * silently, with a 200. An absent header only costs a progress bar; a WRONG one costs
   * the download. So the recorded size is used as history, never as a wire promise.
   *
   * ── What is measured instead ──────────────────────────────────────────────────────
   * The containing directory is listed again here, one call, non-recursive, and only an
   * entry that is a FILE and carries a numeric `size` counts. Everything else — a
   * listing that throws, a plane that reports no size, a name that is somehow no longer
   * there — answers `undefined` and the response simply carries no `content-length`.
   *
   * ── And why a RUNNING task never gets one ─────────────────────────────────────────
   * The drop box belongs to the agent while the agent is alive: it may be mid-write, and
   * an artifact that grows between the measurement and the read makes the header a lie
   * in the direction that TRUNCATES. Once the Task is terminal nothing writes there any
   * more, which is what turns "measured a moment ago" into "true for this response".
   * The stale-size risk is therefore not accepted-and-hoped-about; it is excluded, and
   * the cases that cannot be excluded are answered with silence.
   */
  private async measureArtifact(
    task: AgentTask,
    files: SandboxFiles,
    handle: SandboxHandle,
    path: string,
  ): Promise<number | undefined> {
    if (task.isRunning) return undefined;
    const slash = path.lastIndexOf('/');
    const dir = slash <= 0 ? '/' : path.slice(0, slash);
    try {
      const entries = await files.listFiles(handle, dir, { recursive: false });
      const entry = entries.find((e) => e.path === path && e.kind === 'file');
      return typeof entry?.size === 'number' ? entry.size : undefined;
    } catch {
      // a failed listing must not turn a working download into an error: the bytes are
      // still there and still streamable, the caller merely loses the progress bar.
      return undefined;
    }
  }

  /**
   * Events after `fromSeq`, rebuilt from the platform's own raw log — the `subscribe`
   * replay the `/tasks` channel promises before it switches to live push.
   */
  async replay(taskId: string, fromSeq: number): Promise<{ seq: number; event: RuntimeEvent }[]> {
    const task = await this.tasks.findById(asAgentTaskId(taskId));
    if (!task) return [];
    return this.workflow.replay(task, fromSeq);
  }

  /** The task itself, for consumers that need more than the DTO (the gateway). */
  findTask(taskId: string): Promise<AgentTask | null> {
    return this.tasks.findById(asAgentTaskId(taskId));
  }

  private async requireSandbox(sandboxId: string): Promise<Sandbox> {
    const sandbox = await this.sandboxes.findById(asSandboxId(sandboxId));
    if (!sandbox) throw new NotFoundException(`sandbox ${sandboxId} not found`);
    return sandbox;
  }

  /**
   * A Task needs a LIVE instance and the runtime the sandbox was provisioned with.
   *
   * The runtime check is not pedantry: provisioning installs exactly one CLI and
   * injects exactly one credential (03 §4.3 ③④), so any other runtime id would reach
   * the sandbox as a missing binary — a 30-second failure with a confusing message
   * instead of an immediate, accurate refusal.
   */
  private assertRunnable(sandbox: Sandbox, runtimeId: string): void {
    if (!this.runtimes.has(runtimeId)) {
      throw new NotFoundException(`unknown runtime '${runtimeId}'`);
    }
    if (!RUNNABLE_STATES.has(sandbox.status)) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        `sandbox ${sandbox.id} is '${sandbox.status}' — a Task can only start on a running one`,
      );
    }
    if (sandbox.runtime !== runtimeId) {
      throw new SandboxProviderError(
        SandboxProviderErrorCode.INVALID_STATE,
        `sandbox ${sandbox.id} was provisioned for runtime '${sandbox.runtime}', not ` +
          `'${runtimeId}' — its CLI and credential are the only ones installed`,
      );
    }
  }

  private async requireTask(sandboxId: string, taskId: string): Promise<AgentTask> {
    const task = await this.tasks.findById(asAgentTaskId(taskId));
    // The sandbox id in the path is part of the task's IDENTITY, not decoration: a task
    // answered under a sandbox it does not belong to is a wrong answer, and a client
    // that stashed `(sandboxId, taskId)` would silently keep working after the pair
    // stopped being true.
    //
    // ⚠️ IT IS ADDRESSING, NOT AUTHORISATION — and the comment here used to claim
    // otherwise. Authorisation on both shells is the access passcode (the REST guard,
    // and the `/tasks` handshake re-checking it itself); there is no per-caller scope
    // for this rule to enforce. The `/tasks` gateway now applies the SAME rule to every
    // socket: its handshake REQUIRES `sandboxId` in the query (`SANDBOX_REQUIRED`
    // otherwise) and `subscribe` compares it exactly as this does — so the two shells
    // answer identically, and neither is a way around the other.
    if (!task || task.sandboxId !== sandboxId) {
      throw new NotFoundException(`task ${taskId} not found in sandbox ${sandboxId}`);
    }
    return task;
  }
}

/**
 * Accept only a relative, traversal-free artifact name; anything else is `null`.
 *
 * Written as an allowlist over SEGMENTS rather than a blocklist of substrings: a
 * `..`-hunting regex has to anticipate every encoding, while "no segment may be `..`,
 * empty, or absolute" is a property of the parsed path itself.
 */
export function sanitizeArtifactName(name: string): string | null {
  const decoded = name.trim();
  if (decoded === '' || decoded.startsWith('/') || decoded.includes('\0')) return null;
  const segments = decoded.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segments.join('/');
}
