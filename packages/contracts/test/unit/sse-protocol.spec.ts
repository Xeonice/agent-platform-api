import { describe, it, expect } from 'vitest';
import {
  DIAGNOSE_CHECK_IDS,
  DIAGNOSE_STATUSES,
  PRESET_IMAGE_CODES,
  PRESET_IMAGE_STEPS,
  SSE_DIAGNOSE_SCHEMA_HASH,
  SSE_PROTOCOL_CANONICAL,
  diagnoseSeverity,
  shouldRecordDiagnose,
} from '@platform/contracts';
import type { DiagnoseStatus } from '@platform/contracts';

/**
 * SSE 帧契约（02 §5.3 / P21-5 §9A）。
 *
 * 这一组的定位与 `ws-protocol.spec.ts` 相同：**把 canonical 字面量与它声称代表的那些
 * 闭集钉在一起**。B5 只保证「两仓的字面量一样」；如果字面量和本文件的枚举各说各话，
 * 两仓可以一起漂而门禁全绿。两条合起来才传递地钉住「后端发的帧 == 前端认的帧」。
 */
describe('SSE 诊断帧契约', () => {
  it('canonical 覆盖八项检查，且顺序就是展示顺序（P21-5 §6）', () => {
    // ⚠️ 不是「包含这八个 id」而是「按这个顺序逐字包含」——顺序本身是产品要求
    //    （异步并行但展示顺序固定），只断言集合会让一次重排安静通过。
    expect(SSE_PROTOCOL_CANONICAL).toContain(`diagnose.checks:${DIAGNOSE_CHECK_IDS.join(',')}`);
    expect(DIAGNOSE_CHECK_IDS).toHaveLength(8);
    expect(DIAGNOSE_CHECK_IDS[7]).toBe('preset-image');
  });

  it('canonical 钉住 status 闭集（含 info 与 timeout 这两个易被合并掉的）', () => {
    expect(SSE_PROTOCOL_CANONICAL).toContain(`diagnose.status:${DIAGNOSE_STATUSES.join(',')}`);
    // info 单列：第 ⑧ 项第 5 步只能是它（未 staged 不是失败，P21-5 §9A）。
    expect(DIAGNOSE_STATUSES).toContain('info');
    // timeout 与 fail 分开：一项 5s 内答不上来 ≠ 这一项是坏的（02 §5.3）。
    expect(DIAGNOSE_STATUSES).toContain('timeout');
  });

  it('canonical 钉住预制镜像五步与前四步的码 —— 第 5 步没有码', () => {
    expect(SSE_PROTOCOL_CANONICAL).toContain(
      `diagnose.preset-image.steps:${PRESET_IMAGE_STEPS.join(',')}`,
    );
    expect(SSE_PROTOCOL_CANONICAL).toContain(
      `diagnose.preset-image.codes:${PRESET_IMAGE_CODES.join(',')}`,
    );
    // ⛔ 五步四码，差的那一个就是 `staged` —— 它不是失败，给它一个错误码就等于承认它是。
    expect(PRESET_IMAGE_STEPS).toHaveLength(5);
    expect(PRESET_IMAGE_CODES).toHaveLength(4);
    expect(PRESET_IMAGE_CODES.some((c) => c.toLowerCase().includes('staged'))).toBe(false);
  });

  it('每一步一个码 —— 四个码互不相同（「不许合成一条」的机器可判形式）', () => {
    expect(new Set<string>(PRESET_IMAGE_CODES).size).toBe(PRESET_IMAGE_CODES.length);
  });

  it('帧字段形状在 canonical 里逐字列出（改字段必须改这一行）', () => {
    expect(SSE_PROTOCOL_CANONICAL).toContain(
      'check{id,label,status,summary,hint?,step?,errorCode?,detail?,durationMs}',
    );
    expect(SSE_PROTOCOL_CANONICAL).toContain('start{checks[{id,label}],timeoutMs}');
    expect(SSE_PROTOCOL_CANONICAL).toContain('done{okCount,infoCount,warnCount,failCount,totalMs}');
  });

  it('schema hash 是独立于 WS 那两个的钉死字面量', () => {
    expect(SSE_DIAGNOSE_SCHEMA_HASH).toBe('sb-diagnose-v1');
  });
});

describe('system.diagnose 只在有失败项时记（13 §2.8.2）', () => {
  const s = (...xs: DiagnoseStatus[]): DiagnoseStatus[] => xs;

  it('全绿不记 —— 页面上就有 [重新诊断]，全绿也记一天能堆出上百条噪音', () => {
    expect(shouldRecordDiagnose(s('ok', 'ok', 'ok'))).toBe(false);
  });

  it('只有 info 也不记 —— info 是「没有任何东西需要修」', () => {
    // ⚠️ 这条是与「全绿不记」不同的一条：第 ⑧ 项第 5 步常态就是 info（镜像还没铺开），
    //    把 info 当成「有异常」会让每一台新部署每次诊断都记一条。
    expect(shouldRecordDiagnose(s('ok', 'info', 'ok'))).toBe(false);
  });

  it('warn / fail / timeout 各自都要记', () => {
    expect(shouldRecordDiagnose(s('ok', 'warn'))).toBe(true);
    expect(shouldRecordDiagnose(s('ok', 'fail'))).toBe(true);
    // timeout 计入：「上一次说好/说坏是什么时候」这个问题里，timeout 属于「没说好」。
    expect(shouldRecordDiagnose(s('ok', 'timeout'))).toBe(true);
  });

  it('severity：fail ⇒ error，warn/timeout ⇒ warn，其余 ⇒ info', () => {
    expect(diagnoseSeverity(s('ok', 'warn', 'fail'))).toBe('error');
    expect(diagnoseSeverity(s('ok', 'warn'))).toBe('warn');
    expect(diagnoseSeverity(s('ok', 'timeout'))).toBe('warn');
    expect(diagnoseSeverity(s('ok', 'info'))).toBe('info');
  });
});
