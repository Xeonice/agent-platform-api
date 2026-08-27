import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { create as tarCreate } from 'tar';
import { CLOCK, availableBytesFor, fromEpochMs, shiftMs } from '@platform/shared-kernel';
import type { Clock } from '@platform/shared-kernel';
import { RUNTIME_LOG_READER, type RuntimeLogReader } from '../logging';
import { env } from '../config/env';
import { AuditRepository } from './audit.repository';

/** P21-5 §10.3：取「最近 24h」与「50MB」中先到的那个。 */
export const EXPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const EXPORT_MAX_BYTES = 50 * 1024 * 1024;

/** 三份内容各自的预算切分。总和 = `EXPORT_MAX_BYTES`。 */
const AUDIT_BUDGET_RATIO = 0.4;

export interface AuditExportResult {
  /** 打好的 tar.gz 的本地路径。调用方负责在流走完之后 `dispose()`。 */
  path: string;
  filename: string;
  dispose: () => Promise<void>;
}

/**
 * `GET /api/system/audit/export` 的打包器（P21-5 §10.3 / 10 §6.6）。
 *
 * ── 包里有什么 ───────────────────────────────────────────────────────────────
 *   1. `audit.jsonl`        —— 审计流（时间范围内，**写入口已脱敏**）
 *   2. `runtime.log`        —— 运行日志（同范围，同一套脱敏）
 *   3. `diagnose.json`      —— 导出时刻的快照 + 版本 / 资源水位
 *   4. `export-range.json`  —— **实际截取范围**
 *
 * ⚠️ 第 4 份是文档「包内注明实际截取范围」的落点。P21-5 §10.3 只点名了三份内容，
 * 但同一句话要求注明范围 —— 前三份各自有固定格式（jsonl / 纯文本行 / 诊断快照），
 * 把范围塞进任何一份都要么破格式、要么藏在读者不会打开的文件里。所以单列一份。
 * **「截断了却不说，会让人以为日志本来就只有这些」**（P21-5 §10.3 原话）。
 *
 * ⚠️ **不 shell out 到 `tar`。** 开发机 macOS 是 BSD tar、部署镜像
 * `node:22-bookworm-slim` 是 GNU tar 1.34，同一段参数两边行为不同（已实测）。
 * 用 npm `tar` 包，它自己写 ustar 流。
 *
 * ⚠️ **`runtime.log` 的 provider 可能根本没 bound。** 日志落盘是另一条并行的切片；
 * 没落地时 `RUNTIME_LOG_READER` 不存在 —— 那就**省掉这一份并在范围说明里写清缺失
 * 原因**，而不是让导出 500。「日志落盘未实现」不该让「导出审计流」也用不了。
 */
@Injectable()
export class AuditExportService {
  private readonly logger = new Logger('AuditExport');

  constructor(
    private readonly repo: AuditRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional()
    @Inject(RUNTIME_LOG_READER)
    private readonly runtimeLog?: RuntimeLogReader,
  ) {}

  async pack(): Promise<AuditExportResult> {
    const now = this.clock.now();
    // `fromEpochMs` 而不是 `new Date(…)` —— 全仓禁 Date 构造器（01 §3）。
    const to = fromEpochMs(now.getTime());
    const from = shiftMs(fromEpochMs(now.getTime()), -EXPORT_WINDOW_MS);

    const dir = await mkdtemp(join(os.tmpdir(), 'audit-export-'));
    const dispose = async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    };

    try {
      const auditRange = await this.writeAuditJsonl(dir, from, to);
      const logRange = await this.writeRuntimeLog(dir, from, to);
      const diagnose = await this.writeDiagnose(dir, now);

      const range = {
        generatedAt: now.toISOString(),
        // 「先到者」的两个闸，原样写出来 —— 读者据此判断自己看到的是不是全部。
        requestedWindow: { from: from.toISOString(), to: to.toISOString(), hours: 24 },
        maxBytes: EXPORT_MAX_BYTES,
        audit: auditRange,
        runtimeLog: logRange,
        diagnose,
      };
      await writeFile(join(dir, 'export-range.json'), `${JSON.stringify(range, null, 2)}\n`);

      const entries = ['audit.jsonl', 'export-range.json', 'diagnose.json'];
      if (logRange.included) entries.push('runtime.log');

      const stamp = now.toISOString().replace(/[:.]/g, '-');
      const filename = `audit-export-${stamp}.tar.gz`;
      const archive = join(dir, filename);
      // `create()` 不带 `file` 时回一个可读流；带 `file` 时回一个 Promise。这里落成
      // 文件，因为 HTTP 层要能在出错时改回 500，而流一旦开始写就没有回头路了。
      await tarCreate({ gzip: true, cwd: dir, file: archive, portable: true }, entries);
      return { path: archive, filename, dispose };
    } catch (e) {
      await dispose();
      throw e;
    }
  }

  /**
   * 审计流 → `audit.jsonl`。**按 seq 升序**（一条流水该按时间正序读）。
   *
   * 预算用完即停，并在范围说明里写 `truncated: true` —— 这正是「截断了却不说」要
   * 防的那件事。截断从**旧的一头**开始丢：导出是为了排刚刚发生的障。
   */
  private async writeAuditJsonl(
    dir: string,
    from: Date,
    to: Date,
  ): Promise<{
    included: boolean;
    events: number;
    oldest?: string;
    newest?: string;
    truncated: boolean;
    truncatedBy?: 'size-budget';
    availableInWindow: number;
  }> {
    const budget = Math.floor(EXPORT_MAX_BYTES * AUDIT_BUDGET_RATIO);
    const all = this.repo.streamForExport({ from, to });
    const lines: string[] = [];
    let bytes = 0;
    let truncated = false;
    // 从最新一端倒着收，收满预算为止，再翻回正序 —— 保证被丢的是最旧的那些。
    for (let i = all.length - 1; i >= 0; i--) {
      const line = `${JSON.stringify(all[i])}\n`;
      const size = Buffer.byteLength(line, 'utf8');
      if (bytes + size > budget) {
        truncated = true;
        break;
      }
      lines.push(line);
      bytes += size;
    }
    lines.reverse();
    await writeFile(join(dir, 'audit.jsonl'), lines.join(''), 'utf8');

    const first = lines[0];
    const last = lines[lines.length - 1];
    return {
      included: true,
      events: lines.length,
      ...(first === undefined ? {} : { oldest: readAt(first) }),
      ...(last === undefined ? {} : { newest: readAt(last) }),
      truncated,
      ...(truncated ? { truncatedBy: 'size-budget' as const } : {}),
      availableInWindow: all.length,
    };
  }

  /**
   * 运行日志 → `runtime.log`。三种结局，**每一种都要在范围说明里说清是哪一种**：
   *   · provider 未 bound  ⇒ 日志落盘尚未接入（另一条切片）
   *   · reader 回 `null`   ⇒ 设施在、但一行都还没写过
   *   · 正常                ⇒ 落盘，记录实际字节数与是否触到预算
   */
  private async writeRuntimeLog(
    dir: string,
    from: Date,
    to: Date,
  ): Promise<{ included: boolean; bytes?: number; truncated?: boolean; omittedReason?: string }> {
    if (!this.runtimeLog) {
      return {
        included: false,
        omittedReason:
          'RUNTIME_LOG_READER 未注册：运行日志落盘设施尚未接入本次部署（P21-5 §10.4）。' +
          '本包因此只含审计流与诊断快照 —— 缺的不是"这段时间没有日志"，是"平台还没有在存日志"。',
      };
    }
    const budget = EXPORT_MAX_BYTES - Math.floor(EXPORT_MAX_BYTES * AUDIT_BUDGET_RATIO);
    let stream: NodeJS.ReadableStream | null;
    try {
      stream = this.runtimeLog.read({ from, to, maxBytes: budget });
    } catch (e) {
      this.logger.warn(`runtime log reader threw: ${(e as Error).message}`);
      return {
        included: false,
        omittedReason: `读取运行日志失败：${(e as Error).message}`,
      };
    }
    if (!stream) {
      return {
        included: false,
        omittedReason: '运行日志设施已就绪，但落盘文件不存在或为空（还没有写过任何一行）。',
      };
    }
    const target = join(dir, 'runtime.log');
    await pipeline(stream, createWriteStream(target));
    const size = (await stat(target)).size;
    return { included: true, bytes: size, truncated: size >= budget };
  }

  /**
   * `diagnose.json` —— 导出时刻的快照 + 版本 / 资源水位（P21-5 §10.3 第 3 份）。
   *
   * ⚠️ **`POST /api/system/diagnose`（02 §5.3 的 SSE 逐项检查）尚未落地**，所以这里
   * **不假装跑过一轮检查**：`checks` 是空数组并附一句 `checksUnavailable` 说明。
   * 编一份"全绿"的诊断快照，比没有诊断快照坏得多 —— 读者会据此排除掉本该查的方向。
   */
  private async writeDiagnose(dir: string, now: Date): Promise<{ checks: number }> {
    const dataRoot = env.dataRoot;
    const free = await availableBytesFor(dataRoot).catch(() => Number.POSITIVE_INFINITY);
    const snapshot = {
      at: now.toISOString(),
      platform: {
        node: process.version,
        os: `${os.type()} ${os.release()} ${os.arch()}`,
        uptimeSec: Math.floor(process.uptime()),
      },
      resources: {
        cpuCount: os.cpus().length,
        loadAvg: os.loadavg(),
        totalMemBytes: os.totalmem(),
        freeMemBytes: os.freemem(),
        rssBytes: process.memoryUsage().rss,
        dataRoot,
        dataRootFreeBytes: Number.isFinite(free) ? free : null,
      },
      checks: [] as unknown[],
      checksUnavailable:
        'POST /api/system/diagnose（02 §5.3 的逐项检查）尚未落地，本快照因此不含检查结果。' +
        '这里刻意留空而不是填一份"全绿"——编造的诊断会让读者排除掉本该查的方向。',
    };
    await writeFile(join(dir, 'diagnose.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
    return { checks: 0 };
  }
}

/** 从一行 jsonl 里读回 `at`，只为写范围说明；读不出就不写这个键。 */
function readAt(line: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null && 'at' in parsed) {
      const at = (parsed as { at?: unknown }).at;
      return typeof at === 'string' ? at : undefined;
    }
  } catch {
    /* 不该发生（这一行刚被我们 stringify 出来）；读不出就不写。 */
  }
  return undefined;
}
