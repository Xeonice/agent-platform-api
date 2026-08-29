import { describe, it, expect, vi } from 'vitest';
import { DIAGNOSE_CHECK_IDS } from '@platform/contracts';
import type {
  AuditRecordInput,
  AuditRecorder,
  DiagnoseCheckFrame,
  DiagnoseCheckId,
  DiagnoseDoneFrame,
  DiagnoseServerFrame,
  DiagnoseStartFrame,
} from '@platform/contracts';
import type { Clock } from '@platform/shared-kernel';
import {
  DiagnosticsService,
  DIAGNOSE_TIMEOUT_MS,
} from '../../../src/platform/system/diagnostics/diagnostics.service';
import type {
  DiagnoseCheck,
  DiagnoseCheckResult,
} from '../../../src/platform/system/diagnostics/checks/check.types';

/** 递增的假时钟 —— 每次读前进 1ms，于是 durationMs 是确定的正数而不是随机的 0。 */
function fakeClock(): Clock {
  let t = 1_700_000_000_000;
  return {
    now: () => {
      t += 1;
      return new Date(t);
    },
  };
}

function stubCheck(
  id: DiagnoseCheckId,
  result: DiagnoseCheckResult | (() => Promise<DiagnoseCheckResult>),
): DiagnoseCheck {
  return {
    id,
    label: `label:${id}`,
    run: typeof result === 'function' ? result : () => Promise.resolve(result),
  };
}

const OK: DiagnoseCheckResult = { status: 'ok', summary: 'fine' };

function allChecks(
  overrides: Partial<
    Record<DiagnoseCheckId, DiagnoseCheckResult | (() => Promise<DiagnoseCheckResult>)>
  > = {},
): DiagnoseCheck[] {
  return DIAGNOSE_CHECK_IDS.map((id) => stubCheck(id, overrides[id] ?? OK));
}

function harness(checks: DiagnoseCheck[]): {
  service: DiagnosticsService;
  audits: AuditRecordInput[];
} {
  const audits: AuditRecordInput[] = [];
  const audit: AuditRecorder = { record: (r) => void audits.push(r) };
  return { service: new DiagnosticsService(checks, audit, fakeClock()), audits };
}

async function collect(service: DiagnosticsService): Promise<DiagnoseServerFrame[]> {
  const frames: DiagnoseServerFrame[] = [];
  await service.run((f) => frames.push(f), new AbortController().signal);
  return frames;
}

const startOf = (fs: DiagnoseServerFrame[]): DiagnoseStartFrame =>
  fs.find((f): f is DiagnoseStartFrame => f.event === 'start')!;
const doneOf = (fs: DiagnoseServerFrame[]): DiagnoseDoneFrame =>
  fs.find((f): f is DiagnoseDoneFrame => f.event === 'done')!;
const checksOf = (fs: DiagnoseServerFrame[]): DiagnoseCheckFrame[] =>
  fs.filter((f): f is DiagnoseCheckFrame => f.event === 'check');

describe('DiagnosticsService —— 帧序与完整性', () => {
  it('首帧是 start，按契约顺序列出全部八项（页面据它画 ⏳ 占位）', async () => {
    const { service } = harness(allChecks());
    const frames = await collect(service);
    expect(frames[0]!.event).toBe('start');
    expect(startOf(frames).checks.map((c) => c.id)).toEqual([...DIAGNOSE_CHECK_IDS]);
    expect(startOf(frames).timeoutMs).toBe(DIAGNOSE_TIMEOUT_MS);
  });

  it('末帧是 done，八项各出一帧 check', async () => {
    const { service } = harness(allChecks());
    const frames = await collect(service);
    expect(frames.at(-1)!.event).toBe('done');
    expect(checksOf(frames)).toHaveLength(8);
    expect(new Set(checksOf(frames).map((f) => f.id)).size).toBe(8);
  });

  it('装配少一项 ⇒ 当场抛，而不是安静地少发一帧', async () => {
    // ⚠️ 少发一帧的后果是前端那一格**永远停在 ⏳** —— 一个看起来像「还在跑」的永久状态。
    const { service } = harness(allChecks().slice(0, 7));
    await expect(collect(service)).rejects.toThrow(/缺 \[preset-image\]/);
  });

  it('装配多一项（契约里没有的 id）⇒ 同样当场抛', async () => {
    const rogue = stubCheck('made-up' as DiagnoseCheckId, OK);
    const { service } = harness([...allChecks(), rogue]);
    await expect(collect(service)).rejects.toThrow(/多 \[made-up\]/);
  });
});

describe('DiagnosticsService —— 一项坏掉不阻塞整轮（02 §5.3）', () => {
  it('一项抛异常 ⇒ 它自己是 fail，其余七项照常出帧', async () => {
    const { service } = harness(allChecks({ 'dev-kvm': () => Promise.reject(new Error('boom')) }));
    const frames = await collect(service);
    expect(checksOf(frames)).toHaveLength(8);
    const kvm = checksOf(frames).find((f) => f.id === 'dev-kvm')!;
    expect(kvm.status).toBe('fail');
    expect(kvm.summary).toContain('boom');
    expect(checksOf(frames).filter((f) => f.status === 'ok')).toHaveLength(7);
  });

  it('一项超时 ⇒ status:"timeout"，整轮不被它拖住', async () => {
    vi.useFakeTimers();
    try {
      const { service } = harness(
        // 永不 settle 的那一项 —— 「系统好像坏了」时最常见的形态。
        allChecks({ 'outbound-network': () => new Promise<DiagnoseCheckResult>(() => undefined) }),
      );
      const frames: DiagnoseServerFrame[] = [];
      const done = service.run((f) => frames.push(f), new AbortController().signal);
      await vi.advanceTimersByTimeAsync(DIAGNOSE_TIMEOUT_MS + 10);
      await done;
      const outbound = checksOf(frames).find((f) => f.id === 'outbound-network')!;
      expect(outbound.status).toBe('timeout');
      expect(checksOf(frames)).toHaveLength(8);
      expect(frames.at(-1)!.event).toBe('done');
      // ⚠️ timeout 必须计进 failCount：给出「7 ok / 0 fail」这种读数会让人以为
      //    「没有失败」，而其实有一项 5s 内答不上来。
      expect(doneOf(frames).failCount).toBe(1);
      expect(doneOf(frames).okCount).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('done 的计数把 timeout 计进 failCount —— 「答不上来」不是「好的」', async () => {
    const { service } = harness(
      allChecks({
        'dev-kvm': { status: 'info', summary: 'n/a' },
        'disk-space': { status: 'warn', summary: 'tight' },
        'port-conflict': { status: 'fail', summary: 'taken' },
      }),
    );
    const frames = await collect(service);
    const done = doneOf(frames);
    expect(done.okCount).toBe(5);
    expect(done.infoCount).toBe(1);
    expect(done.warnCount).toBe(1);
    expect(done.failCount).toBe(1);
  });

  it('断连 ⇒ 不再发帧（诊断只读，中止无副作用）', async () => {
    const controller = new AbortController();
    const { service } = harness(allChecks());
    const frames: DiagnoseServerFrame[] = [];
    controller.abort();
    await service.run((f) => frames.push(f), controller.signal);
    // start 仍然发（它在 abort 检查之前，且此时连接可能刚断）；check/done 一帧都不发。
    expect(checksOf(frames)).toHaveLength(0);
    expect(frames.filter((f) => f.event === 'done')).toHaveLength(0);
  });
});

describe('DiagnosticsService —— system.diagnose 审计（13 §2.8.2）', () => {
  it('⛔ 全绿不记 —— 一天能堆出上百条「一切正常」，把真正的信号冲掉', async () => {
    const { service, audits } = harness(allChecks());
    await collect(service);
    expect(audits).toHaveLength(0);
  });

  it('只有 info 也不记（第 ⑧ 项第 5 步在新部署上是常态）', async () => {
    const { service, audits } = harness(
      allChecks({ 'preset-image': { status: 'info', summary: '未 staged' } }),
    );
    await collect(service);
    expect(audits).toHaveLength(0);
  });

  it('有 fail ⇒ 记一条 error，summary 点名是哪几项', async () => {
    const { service, audits } = harness(
      allChecks({ 'port-conflict': { status: 'fail', summary: 'taken' } }),
    );
    await collect(service);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      category: 'system',
      type: 'system.diagnose',
      severity: 'error',
      outcome: 'failed',
      actor: 'user',
    });
    expect(audits[0]!.summary).toContain('label:port-conflict');
  });

  it('有 warn 但无 fail ⇒ 记一条 warn', async () => {
    const { service, audits } = harness(
      allChecks({ 'disk-space': { status: 'warn', summary: 'tight' } }),
    );
    await collect(service);
    expect(audits[0]!.severity).toBe('warn');
  });

  it('detail 只放逐项结论，不放各项的 detail（那里面有 pid / 路径 / digest）', async () => {
    const { service, audits } = harness(
      allChecks({
        'port-conflict': {
          status: 'fail',
          summary: 'taken',
          detail: { holders: [{ pid: 41235, command: 'com.docke' }] },
        },
      }),
    );
    await collect(service);
    const serialized = JSON.stringify(audits[0]!.detail);
    expect(serialized).toContain('port-conflict');
    // 审计回答「发生了什么」，不回答「为什么」—— 深度排障看运行日志（P21-5 §10.1）。
    expect(serialized).not.toContain('41235');
  });
});
