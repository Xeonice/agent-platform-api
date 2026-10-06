import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import {
  AUDIT_RECORDER,
  DIAGNOSE_CHECK_IDS,
  diagnoseSeverity,
  shouldRecordDiagnose,
} from '@platform/contracts';
import type {
  AuditRecorder,
  DiagnoseCheckFrame,
  DiagnoseCheckId,
  DiagnoseServerFrame,
  DiagnoseStatus,
} from '@platform/contracts';
import { DIAGNOSE_CHECKS, type DiagnoseCheck } from './checks/check.types';
import { DiagnosticSnapshotService } from '../../audit/diagnostic-snapshot.service';

/** PARAM.DIAG_ITEM_TIMEOUT_MS：各项并行的单项预算，首帧下发给界面。 */
export const DIAGNOSE_TIMEOUT_MS = 10_000;

/**
 * 逐项诊断的调度器（02 §5.3 / P21-5 §6）。
 *
 * 各项并行，整轮耗时约等于最慢检查，卡住一项不延迟其余结果。
 *
 * ── 三条落地纪律 ────────────────────────────────────────────────────────────
 * 1. **顺序固定的是展示，不是执行。** 首帧 `start` 按 `DIAGNOSE_CHECK_IDS` 下发清单，
 *    `check` 帧按**完成先后**到达 —— 前端按 id 归位。
 * 2. **一项超时/抛异常都不阻塞整轮。** 超时发 `status:'timeout'` 帧继续；抛异常兜底成
 *    `fail` 并打日志（检查自己本该把异常翻译成人话，见 `DiagnoseCheck` 注释）。
 * 3. **断连即中止。** 诊断是只读的，中止没有副作用（02 §5.3）。
 */
@Injectable()
export class DiagnosticsService {
  private readonly logger = new Logger('Diagnostics');

  constructor(
    @Inject(DIAGNOSE_CHECKS) private readonly checks: DiagnoseCheck[],
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly snapshots?: DiagnosticSnapshotService,
  ) {}

  /**
   * 按 `DIAGNOSE_CHECK_IDS` 排好的检查项。
   *
   * ⚠️ **少一项 / 多一项 / id 拼错都在这里当场炸**，而不是安静地少发一帧。少发一帧的
   * 后果是前端那一格永远停在 ⏳ —— 一个看起来像「还在跑」的永久状态，用户会一直等。
   * 契约（`DIAGNOSE_CHECK_IDS`）是权威，装配必须对得上它。
   */
  private ordered(): DiagnoseCheck[] {
    const byId = new Map(this.checks.map((c) => [c.id, c]));
    const missing = DIAGNOSE_CHECK_IDS.filter((id) => !byId.has(id));
    const extra = [...byId.keys()].filter(
      (id) => !(DIAGNOSE_CHECK_IDS as readonly string[]).includes(id),
    );
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `诊断检查项与契约 DIAGNOSE_CHECK_IDS 对不上：缺 [${missing.join(', ')}]，多 [${extra.join(', ')}]。` +
          '契约是权威（sse-protocol.ts），装配要跟着改。',
      );
    }
    return DIAGNOSE_CHECK_IDS.map((id) => byId.get(id)!);
  }

  async run(emit: (frame: DiagnoseServerFrame) => void, signal: AbortSignal): Promise<void> {
    const checks = this.ordered();
    const startFrame = {
      event: 'start',
      checks: checks.map((c) => ({ id: c.id, label: c.label })),
      timeoutMs: DIAGNOSE_TIMEOUT_MS,
    } as const;
    const generation = this.snapshots?.begin(startFrame, this.clock.now());
    emit(startFrame);

    const roundStarted = this.clock.now().getTime();
    const frames: DiagnoseCheckFrame[] = [];
    await Promise.all(
      checks.map(async (check) => {
        const frame = await this.runOne(check, signal);
        frames.push(frame);
        if (!signal.aborted) {
          if (generation !== undefined) this.snapshots?.record(generation, frame);
          emit(frame);
        }
      }),
    );
    if (signal.aborted) {
      if (generation !== undefined) this.snapshots?.abort(generation, this.clock.now());
      return;
    }

    const statuses = frames.map((f) => f.status);
    const count = (s: DiagnoseStatus): number => statuses.filter((x) => x === s).length;
    const doneFrame = {
      event: 'done',
      okCount: count('ok'),
      infoCount: count('info'),
      warnCount: count('warn'),
      // ⚠️ `timeout` 计进 failCount：对「整轮结论」而言，「答不上来」与「答坏了」是同一
      //    件事 —— 都不是「好的」。分开呈现由前端按每项的 status 做，汇总数字不该给出
      //    「7 ok / 1 timeout」这种让人以为「没有失败」的读数。
      failCount: count('fail') + count('timeout'),
      totalMs: this.clock.now().getTime() - roundStarted,
    } as const;
    if (generation !== undefined) this.snapshots?.finish(generation, doneFrame, this.clock.now());
    emit(doneFrame);

    this.recordAudit(frames);
  }

  /** 单项：计时 + 超时竞速 + 兜底 catch。 */
  private async runOne(check: DiagnoseCheck, signal: AbortSignal): Promise<DiagnoseCheckFrame> {
    const started = this.clock.now().getTime();
    const base = { event: 'check' as const, id: check.id as DiagnoseCheckId, label: check.label };
    try {
      const result = await withTimeout(
        check.run({ timeoutMs: DIAGNOSE_TIMEOUT_MS, signal }),
        DIAGNOSE_TIMEOUT_MS,
      );
      if (result === TIMED_OUT) {
        return {
          ...base,
          status: 'timeout',
          // ⚠️ 「超时」≠「不可达」：这一项**没有结论**，不是「结论是坏的」。
          headline: `${String(DIAGNOSE_TIMEOUT_MS / 1000)} 秒内没有结果`,
          detailText: '这一项这次没有结论，其余项不受影响。',
          nextStep: '看这一项依赖的东西是卡住了还是在报错；再跑一次诊断，看它是不是每次都超时。',
          durationMs: this.clock.now().getTime() - started,
        };
      }
      return { ...base, ...result, durationMs: this.clock.now().getTime() - started };
    } catch (e) {
      // 防御，不是设计：`DiagnoseCheck.run()` 契约上不许抛（它是唯一知道刚才在做什么的
      // 人，翻译成人话是它的责任）。真抛了也不能让整轮塌掉。
      this.logger.error(`诊断项 ${check.id} 抛出异常：${(e as Error).message}`);
      return {
        ...base,
        status: 'fail',
        headline: '这一项检查自己出错了',
        detailText: `${(e as Error).message}`,
        durationMs: this.clock.now().getTime() - started,
      };
    }
  }

  /**
   * `system.diagnose` 审计（13 §2.8.2）。
   *
   * ⛔ **只在有失败项时记。** 页面上就有 [重新诊断]，横幅也能跳进来自动跑一次；全绿也记
   * 的话，一个长命平台一天就能堆出上百条「一切正常」，把真正的信号冲掉 —— 纪律与
   * `sandbox.health`「只在状态翻转时记」同源。
   *
   * ⚠️ `detail` 里只放**逐项的结论**（id / status / summary），不放 `detail` 字段本身：
   * 那里面有路径、pid、digest，一轮各项攒起来能有几 KB，而审计是「发生了什么」不是
   * 「为什么」（P21-5 §10.1）—— 深度排障看运行日志。
   */
  private recordAudit(frames: readonly DiagnoseCheckFrame[]): void {
    const statuses = frames.map((f) => f.status);
    if (!shouldRecordDiagnose(statuses)) return;
    const bad = frames.filter((f) => f.status !== 'ok' && f.status !== 'info');
    this.audit.record({
      category: 'system',
      type: 'system.diagnose',
      severity: diagnoseSeverity(statuses),
      actor: 'user',
      outcome: 'failed',
      summary: `系统诊断发现 ${String(bad.length)} 项异常：${bad.map((f) => f.label).join('、')}`,
      detail: {
        at: this.clock.now().toISOString(),
        checks: frames.map((f) => ({ id: f.id, status: f.status, headline: f.headline })),
      },
    });
  }
}

const TIMED_OUT = Symbol('diagnose-timeout');

/**
 * 超时竞速。
 *
 * ⚠️ 输掉的那个 promise 要挂一个空 `catch` 标记为已处理，否则它稍后 reject 会变成
 * **unhandled rejection**（Node 22 默认让进程退出）—— 与 `ImageSeeder.withBudget` 记的
 * 是同一个坑。计时器 `unref()` + `clearTimeout` 双保险，否则短命进程（测试）会莫名
 * 多挂 5 秒。
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref();
  });
  work.catch(() => undefined);
  return Promise.race([work, budget]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
