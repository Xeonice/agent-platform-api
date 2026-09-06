import { describe, it, expect } from 'vitest';
import { asSandboxId } from '@platform/shared-kernel';
import {
  DISK_INSUFFICIENT,
  SANDBOX_FAILURE_CODES,
  WORKSPACE_PREPARE_FAILED,
  classifyWorkspacePrepareError,
} from '@platform/contracts';
import { harness, waitForStatus } from './_harness';

/**
 * ★ `failureCode` 必须落在 04 §4 的闭集里 —— 2026-08 之前它不是。
 *
 * ── 这条 bug 的形状 ────────────────────────────────────────────────────────────
 * `failureOf` 的注释写着「every error … already carries a code from the 04 §4 closed
 * set」，实现却是「有 `.code` 且非空字符串就用」。Node 的 fs 错误正好带 `.code`，于是
 * 一个写爆盘的 `cp` 让 sandbox 的 `failureCode` 变成字符串 **`ENOSPC`** —— 存进库、
 * 发上 WS、前端按码查 P22 §1 文案表，查不到，落到通用兜底。
 *
 * 于是**最该说清楚的那个失败**（"去清点磁盘空间"）成了最含糊的那个。
 *
 * ⚠️ 而且它不会有任何测试变红：`failed` 状态对、事件发了、E2E 全绿 —— 只有那串码是错的。
 * 这正是"绿灯不等于覆盖"（LIVE-RUN-FINDINGS 共性 2）的又一例。
 *
 * ── 修法是两层，不是一层 ──────────────────────────────────────────────────────
 * ① **抛出处命名**：只有 `FsWorkspacePreparer` 知道自己刚才在做什么 IO，所以由它把
 *    errno 归一成 `WorkspacePrepareError`（事后在 workflow 里猜是猜不准的）。
 * ② **出口校验**：`splitFailure` 拿闭集过一遍，兜住所有没做①的路径，并对被拒的码打
 *    `error` 日志 —— 静默降级成 `INTERNAL` 与"没这个 bug"在外部看起来一模一样。
 *
 * MUTATION: 把 `isSandboxFailureCode(raw)` 换回 `typeof raw === 'string' && raw !== ''`
 * ⇒ 第一条红（拿到 `ENOSPC`）。把 preparer 的 try/catch 去掉 ⇒ 第三条红。
 */
describe('workspace 失败必须带闭集里的码，不能是 errno', () => {
  it('preparer 抛 ENOSPC ⇒ failureCode 不是 errno，而是 INTERNAL（出口兜底生效）', async () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), {
      code: 'ENOSPC',
    });
    const h = harness({ workspaceError: enospc });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'failed');

    const sandbox = await h.repo.findById(asSandboxId(dto.id));
    // ① 出线的码一定属于这套词汇表 —— 前端能拿它查到一句话。
    expect(SANDBOX_FAILURE_CODES.has(sandbox?.failureCode ?? '')).toBe(true);
    // ② 具体地说：errno 没有逃出去。
    expect(sandbox?.failureCode).not.toBe('ENOSPC');
    // ③ 原始 errno 不丢 —— 它在 message 里，供日志与 traceId 排查。
    expect(sandbox?.failureReason ?? '').toContain('ENOSPC');
  });

  it('preparer 抛已归类的 WorkspacePrepareError ⇒ 码原样出线', async () => {
    const h = harness({
      workspaceError: classifyWorkspacePrepareError(
        Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }),
      ),
    });
    const dto = await h.service.create({ projectId: 'prj-1', runtime: 'claude-code' });
    await waitForStatus(h.service, dto.id, 'failed');

    const sandbox = await h.repo.findById(asSandboxId(dto.id));
    // 这是 ① 层（抛出处命名）真正的收益：用户拿到的不是"内部错误"，而是"磁盘不足"——
    // 一句他自己能处理的话。出口兜底给不出这个，因为它不知道刚才在做什么 IO。
    expect(sandbox?.failureCode).toBe(DISK_INSUFFICIENT);
  });
});

describe('classifyWorkspacePrepareError：errno → 闭集', () => {
  it('ENOSPC / EDQUOT 单独成码 —— 这一类对用户意味着一件他做得到的事', () => {
    for (const errno of ['ENOSPC', 'EDQUOT']) {
      const e = classifyWorkspacePrepareError(Object.assign(new Error('x'), { code: errno }));
      expect(e.code, errno).toBe(DISK_INSUFFICIENT);
    }
  });

  it('其余 errno 一律 WORKSPACE_PREPARE_FAILED —— 用户的处置完全一致，多分码只多一处漂移', () => {
    for (const errno of ['EACCES', 'ENOENT', 'EMFILE', 'ENOTDIR', 'EPERM']) {
      const e = classifyWorkspacePrepareError(Object.assign(new Error('x'), { code: errno }));
      expect(e.code, errno).toBe(WORKSPACE_PREPARE_FAILED);
    }
  });

  it('原始错误进 cause，不丢', () => {
    const raw = Object.assign(new Error('boom'), { code: 'EACCES' });
    expect(classifyWorkspacePrepareError(raw).cause).toBe(raw);
  });

  it('已经是 WorkspacePrepareError ⇒ 原样返回，不二次包装', () => {
    const first = classifyWorkspacePrepareError(new Error('x'));
    expect(classifyWorkspacePrepareError(first)).toBe(first);
  });

  it('两个码都在闭集里 —— 否则出口会把它们降级成 INTERNAL，白做了 ①', () => {
    expect(SANDBOX_FAILURE_CODES.has(WORKSPACE_PREPARE_FAILED)).toBe(true);
    expect(SANDBOX_FAILURE_CODES.has(DISK_INSUFFICIENT)).toBe(true);
  });
});
