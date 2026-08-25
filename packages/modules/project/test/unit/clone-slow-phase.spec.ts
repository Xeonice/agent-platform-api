import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Clock } from '@platform/shared-kernel';
import { CloneProjectWorkflow } from '../../src/application/clone-project.workflow';
import type {
  CloneProgress,
  CloneRequest,
  GitCloner,
} from '../../src/domain/ports/git-cloner.port';
import {
  FakeBaselineManager,
  InMemoryProjectRepo,
  NoGitCredentialFacade,
  RecordingBroadcaster,
  directUow,
  gitProject,
} from './_project-doubles';

/**
 * 慢仓库提示 `phase:'slow'` (03 §7.2 「慢仓库提示」, 10 §6) —— 2026-08 补上产出方。
 *
 * ── 一个"处处都在、唯独没人发"的状态 ─────────────────────────────────────────
 * `slow` 出现在：`ws-protocol.ts` 的联合类型、web 的 zod 枚举、`ProjectCloneState`、
 * `useProjectClone.isSlow`、`CloneProgress.view` 的黄字分支、以及**两个 Storybook
 * story**（story 里它当然会显示——数据是手写的）。后端 `clone-project.workflow.ts`
 * 只发过 `cloning` / `done` / `failed` 三种。
 *
 * 于是整条链路"看起来完整"，类型检查通过，story 截得出图，而它在生产里**一次都不会
 * 出现**。这类幽灵态比缺失更难发现：缺失会在某处报错，幽灵态哪里都不报。
 *
 * ── 两个实现细节是从前端的形状倒推出来的，不是可选的润色 ──────────────────────
 * ① **粘性**：store（`createProjectCloneSlice`）每来一个事件就**整体替换** clone 状态。
 *    若 `slow` 之后的进度帧仍报 `cloning`，警告会在最多 1 秒后被抹掉 —— 用户在第 10
 *    分钟看到黄字闪一下，然后再也不见。
 * ② **`slow` 帧自带最后一次进度**：同理，一个裸 `{phase:'slow'}` 会把 stage/percent/
 *    速率全部清空，进度条掉回不确定态的脉冲 —— 我们告诉用户「还在跑」的那一刻，正好
 *    是界面不再显示跑到哪儿的那一刻。
 *
 * MUTATION: 删掉 `slowTimer` ⇒ 第一条红；把 `phase: slow ? 'slow' : 'cloning'` 改回
 * 常量 `'cloning'` ⇒ 第二条红；把 `slow` 帧里的 `lastProgress?.*` 换成 undefined ⇒ 第三条红。
 */
const TEN_MIN = 10 * 60 * 1000;

/** A clone that never finishes on its own — the situation `slow` exists to describe. */
class HangingCloner implements GitCloner {
  readonly requests: CloneRequest[] = [];
  private release: (() => void) | null = null;
  private onProgress: ((p: CloneProgress) => void) | null = null;
  async clone(req: CloneRequest): Promise<void> {
    this.requests.push(req);
    this.onProgress = req.onProgress;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  push(p: CloneProgress): void {
    this.onProgress?.(p);
  }
  finish(): void {
    this.release?.();
  }
  get aborted(): boolean {
    return this.requests[0]?.signal.aborted ?? false;
  }
}

/** Advanceable clock — the 1s progress throttle reads it, so a fixed one gags us. */
function movingClock(): Clock & { advance: (ms: number) => void } {
  let t = new Date('2026-01-01T00:00:00Z').getTime();
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

interface Wired {
  workflow: CloneProjectWorkflow;
  cloner: HangingCloner;
  ws: RecordingBroadcaster;
  clock: ReturnType<typeof movingClock>;
}

function wire(): Wired {
  const repo = new InMemoryProjectRepo();
  repo.add(gitProject('prj-1'));
  const cloner = new HangingCloner();
  const baseline = new FakeBaselineManager();
  baseline.available = Number.POSITIVE_INFINITY;
  const ws = new RecordingBroadcaster();
  const clock = movingClock();
  const workflow = new CloneProjectWorkflow(
    repo,
    directUow,
    clock,
    cloner,
    baseline,
    ws,
    new NoGitCredentialFacade(),
  );
  return { workflow, cloner, ws, clock };
}

/** `enqueue` fires a background promise; let the microtask queue drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const progressEvents = (ws: RecordingBroadcaster) =>
  ws.events.filter((e) => e.event === 'project.clone_progress');

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("phase:'slow' —— 10 分钟仍未完成时告诉用户，但不终止", () => {
  it('超过 10min ⇒ 恰好补发一帧 slow，且 clone 继续跑（没有 abort、没有 failed）', async () => {
    const w = wire();
    w.workflow.enqueue('prj-1');
    await settle();
    w.cloner.push({ stage: 'receiving', percent: 42, objectsDone: 11_000, objectsTotal: 26_348 });
    await settle();

    await vi.advanceTimersByTimeAsync(TEN_MIN);
    await settle();

    const slow = progressEvents(w.ws).filter((e) => e.phase === 'slow');
    expect(slow).toHaveLength(1);
    // 「不终止」是这条产品规则的重点：它只改变说法，不改变行为。
    expect(w.cloner.aborted).toBe(false);
    expect(progressEvents(w.ws).some((e) => e.phase === 'failed')).toBe(false);
  });

  it('slow 帧自带最后一次进度 —— 否则进度条在这一刻掉回不确定态', async () => {
    const w = wire();
    w.workflow.enqueue('prj-1');
    await settle();
    w.cloner.push({
      stage: 'receiving',
      percent: 42,
      objectsDone: 11_000,
      objectsTotal: 26_348,
      bytesPerSecond: 189_000,
    });
    await settle();

    await vi.advanceTimersByTimeAsync(TEN_MIN);
    await settle();

    const slow = progressEvents(w.ws).find((e) => e.phase === 'slow');
    expect(slow?.stage).toBe('receiving');
    expect(slow?.percent).toBe(42);
    expect(slow?.objectsTotal).toBe(26_348);
    expect(slow?.bytesPerSecond).toBe(189_000);
  });

  it('slow 之后的进度帧继续报 slow —— 否则警告在 1 秒后被 store 抹掉', async () => {
    const w = wire();
    w.workflow.enqueue('prj-1');
    await settle();

    await vi.advanceTimersByTimeAsync(TEN_MIN);
    await settle();

    w.clock.advance(2000); // 越过 1s 节流，让下一帧真的发出去
    w.cloner.push({ stage: 'receiving', percent: 43, objectsDone: 11_300, objectsTotal: 26_348 });
    await settle();

    const after = progressEvents(w.ws).filter((e) => e.percent === 43);
    expect(after).toHaveLength(1);
    expect(after[0]?.phase).toBe('slow');
  });

  it('10min 内完成 ⇒ 一帧 slow 都没有，且定时器不会在事后放炮', async () => {
    const w = wire();
    w.workflow.enqueue('prj-1');
    await settle();
    w.cloner.finish();
    await settle();

    // 走完之后再把时钟推过 10min：`finally` 里若没 clearTimeout，这里会补出一帧 slow，
    // 而项目那时已经 ready —— 界面会对一个已完成的项目说「仍在克隆」。
    await vi.advanceTimersByTimeAsync(TEN_MIN * 2);
    await settle();

    expect(progressEvents(w.ws).some((e) => e.phase === 'slow')).toBe(false);
    expect(progressEvents(w.ws).some((e) => e.phase === 'done')).toBe(true);
  });
});
