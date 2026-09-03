import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { AgentTaskDtoSchema } from '@platform/contracts';
import { asAgentTaskId, asSandboxId } from '@platform/shared-kernel';
import { AgentTask, type AgentTaskProps } from '../../src/domain/entities/agent-task.entity';
import { AgentTaskMapper } from '../../src/application/dto/agent-task.mapper';

/**
 * 领域聚合 → 线上 DTO 的那道边界（28 §4）。
 *
 * ⚠️ 它此前**没有任何直接测试**：只被 `agent-task.spec.ts` 顺带跑到，而那些用例断言的
 * 是编排（谁先谁后、落没落库），不是「这个 DTO 长什么样」。结果是本文件两条写在注释里
 * 的契约纪律一个字都没被守住 ——
 *   ① 没有值的字段**缺席**而不是 `null`（前端按可选字段消费，`null` 会让每个消费者
 *      写两次判断，zod 的 `.optional()` 更会直接把 `null` 判为非法）；
 *   ② 一行坏数据**不许**掀翻整页历史（`toTier` / `toErrorCode` 那两段长注释讲的就是
 *      这件事，而它们的降级分支一次都没被执行过）。
 */
function task(over: Partial<AgentTaskProps> = {}): AgentTask {
  return AgentTask.rehydrate({
    id: asAgentTaskId('tsk-1'),
    sandboxId: asSandboxId('sbx-1'),
    runtime: 'claude-code',
    jobHandle: { provider: 'boxlite', jobId: 'job-1' },
    cursor: null,
    status: 'running',
    exitCode: null,
    sessionRef: null,
    lastSeq: 0,
    stdoutBytes: 0,
    logPath: '/tmp/x.log',
    artifacts: [],
    errorCode: null,
    timeoutMs: 30 * 60_000,
    startedAt: new Date('2026-09-03T01:00:00.000Z'),
    finishedAt: null,
    cancelRequestedAt: null,
    ...over,
  });
}

describe('AgentTaskMapper.toDto —— 没有值的字段缺席，而不是 null', () => {
  it('⭐ 一个刚起跑的任务：四个可选字段一个键都不出现', () => {
    const dto = AgentTaskMapper.toDto(task());

    // ⚠️ 用键集合而不是 `toBeUndefined()`：`{exitCode: undefined}` 会让
    // `toBeUndefined()` 通过，但 `JSON.stringify` 之后与「缺席」确实同形，
    // 而 `{exitCode: null}`（真正的退化形态）也会让 `toBeUndefined()` 红 —— 只有
    // 逐键比对能同时挡住 `null` 与「多写了一个键」。
    expect(Object.keys(dto).sort()).toEqual(
      [
        'artifacts',
        'id',
        'lastSeq',
        'runtime',
        'sandboxId',
        'startedAt',
        'status',
        'timeoutMinutes',
      ].sort(),
    );
    // 契约自己也认这个形状（缺席合法，null 非法）。
    expect(AgentTaskDtoSchema.safeParse(dto).success).toBe(true);
    expect(AgentTaskDtoSchema.safeParse({ ...dto, exitCode: null }).success).toBe(false);
  });

  it('⭐ 有值就出现 —— 包括 `exitCode: 0` 这个假值', () => {
    // `0` 是**成功**退出码，也是本仓最容易被 `task.exitCode ? … : {}` 写没的那一个。
    const dto = AgentTaskMapper.toDto(
      task({
        status: 'succeeded',
        exitCode: 0,
        sessionRef: 'sess-abc',
        finishedAt: new Date('2026-09-03T01:05:00.000Z'),
      }),
    );

    expect(dto.exitCode).toBe(0);
    expect('exitCode' in dto).toBe(true);
    expect(dto.sessionRef).toBe('sess-abc');
    expect(dto.finishedAt).toBe('2026-09-03T01:05:00.000Z');
    expect(dto.startedAt).toBe('2026-09-03T01:00:00.000Z');
  });

  it('errorCode 只在失败时出现，且原样带出闭集里的那个码', () => {
    const failed = AgentTaskMapper.toDto(task({ status: 'failed', errorCode: 'TASK_TIMED_OUT' }));
    expect(failed.errorCode).toBe('TASK_TIMED_OUT');
    // 成功的那一条不能带 errorCode —— 前端只要看到这个键就会渲染失败态。
    expect('errorCode' in AgentTaskMapper.toDto(task({ status: 'succeeded' }))).toBe(false);
  });

  it('产物逐条映射出三个字段，绝对路径不外泄', () => {
    const dto = AgentTaskMapper.toDto(
      task({
        artifacts: [
          { name: 'out/report.md', size: 12, modifiedAt: '2026-09-03T01:04:00.000Z' },
          { name: 'diff.patch', size: 0, modifiedAt: '2026-09-03T01:04:30.000Z' },
        ],
      }),
    );
    expect(dto.artifacts).toEqual([
      { name: 'out/report.md', size: 12, modifiedAt: '2026-09-03T01:04:00.000Z' },
      { name: 'diff.patch', size: 0, modifiedAt: '2026-09-03T01:04:30.000Z' },
    ]);
  });
});

describe('一行坏数据不许掀翻整页历史', () => {
  it('毫秒预算换算成档位：四档各自对得上', () => {
    for (const [ms, tier] of [
      [30 * 60_000, 30],
      [60 * 60_000, 60],
      [120 * 60_000, 120],
      [240 * 60_000, 240],
    ] as const) {
      expect(AgentTaskMapper.toDto(task({ timeoutMs: ms })).timeoutMinutes).toBe(tier);
    }
  });

  it('⭐ 不在四档上的历史行：报最近的**上**一档，而不是抛', () => {
    // 这里以前是 `TaskTimeoutMinutesSchema.parse`，一行坏数据能让 `GET /tasks` 整页 500
    // ——恰好是用户在排查"刚才那次到底怎么了"的时候。
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      expect(AgentTaskMapper.toDto(task({ timeoutMs: 45 * 60_000 })).timeoutMinutes).toBe(60);
      // 超出最高档 ⇒ 落到 240，同样不抛。
      expect(AgentTaskMapper.toDto(task({ timeoutMs: 500 * 60_000 })).timeoutMinutes).toBe(240);
      // ⭐ 正向证据：确实走了降级分支（异常被**报告**了，只是没有决定 200 行的死活）。
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([
        'agent task has a non-tier timeout of 45min; reporting the nearest tier',
        'agent task has a non-tier timeout of 500min; reporting the nearest tier',
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('⭐ 闭集之外的 errorCode：报 INTERNAL，而不是抛，也不是原样透出去', () => {
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const dto = AgentTaskMapper.toDto(task({ status: 'failed', errorCode: 'WAT_IS_THIS' }));
      // 原样透出去会让前端 zod 当场炸掉整页（跨仓契约事故的形状之一）。
      expect(dto.errorCode).toBe('INTERNAL');
      expect(AgentTaskDtoSchema.safeParse(dto).success).toBe(true);
      // ⭐ 正向证据：走的是降级分支，不是"碰巧 INTERNAL 也在闭集里"。
      expect(spy).toHaveBeenCalledWith(
        "agent task carries an unknown errorCode 'WAT_IS_THIS'; reporting INTERNAL",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('合法的码走快路径，不该产生任何告警噪音', () => {
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      AgentTaskMapper.toDto(
        task({ status: 'failed', errorCode: 'TASK_FAILED', timeoutMs: 60 * 60_000 }),
      );
      // 每一行历史都刷一条 error 日志，等于把这个信号本身作废掉。
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
