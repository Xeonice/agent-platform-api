import type { AuditRecordInput } from '@platform/contracts';
import type { PasscodeFailureOutcome } from './passcode-attempt-limiter';

/**
 * 访问口令门的审计行（13 §2.8.2 的 `category: 'system'`）。
 *
 * ── 为什么它非记不可 ─────────────────────────────────────────────────────────
 * `POST /api/access/unlock` 是平台的**第一道门**，连续 5 次失败锁 5 分钟
 * （shared/11 §3.1）。这是纯安全事件：在此之前它只有一行运行日志，而运行日志按 05 §4
 * 的保留策略滚掉，且**不在产品面板上**（P21-5 §10.1）。「昨晚有人在试口令吗」这个问题
 * 因此答不出来 —— 审计设施漏掉的恰好是它最该记的那一类。
 *
 * ── 为什么是纯函数，而不是 controller 里的四段 `this.audit.record({...})` ─────
 * 与 `audit.projector.ts` 的 `project()` 同一个理由：脱开 Nest 容器就能逐条断言。
 * controller 那边因此只剩「判断 → 调一次」，没有值得测的分支。
 *
 * ── ⛔ 这个文件里**永远不会出现口令本身，也不会出现它的任何投影** ─────────────
 * 不记明文、不记前缀/后缀、不记长度、不记 hash。理由不是「谨慎」而是可算的：
 * 长度直接把爆破空间从 58^16 砍到 58^n；hash 让离线爆破变成本地算力问题；
 * 前缀两者兼得。所以这几个函数**根本不接受口令参数** —— 纪律因此在**签名**上成立，
 * 而不是靠下一个改这里的人记得删。落库时 `audit-redaction.ts` 还会再遮一层
 * （键名黑名单含 `passcode`），但那是兜底，不是第一道。
 *
 * ── 记什么才真的回答得了「谁在什么时候试了多少次」 ────────────────────────────
 * 单机私有化部署（11 §3.1：没有用户系统），「谁」**没有可记的身份**：只有一个共享
 * 口令，谁输的在平台侧不可知。IP 也几乎不携带信息 —— 家用 NAT / docker bridge 后面
 * 全是同一个 `req.ip`（`passcode.guard.ts` 那条注释记着这个事实已经造成过一次全员
 * 掉线）。⇒ 诚实的做法是**不假装记得下「谁」**，把能答的两问答满：
 *   · **什么时候** = `audit_events.at`（毫秒精度，同一分钟内的连打分得开）；
 *   · **试了多少次** = `consecutiveFailures`，由 limiter 交出来（唯一的计数源）。
 * 面板上按 `category=system` + `severity=warn,error` 一筛，一串 `第 n 次` 就是那晚的
 * 全过程。
 *
 * ⚠️ **`consecutiveFailures` 是那把共享锁的计数，不是「提交口令的次数」。** `PasscodeGuard`
 * 每拦下一个没带有效 cookie 的受保护请求也会 `recordFailure`（11 §3.1：两个入口喂同一把
 * 锁），所以用户第一次输错口令时看到的可能是「连续第 3 次」。这**不是记错了**：这个数
 * 回答的是「离锁上还差几次」，也就是它旁边那句「满 5 次锁定」的分子——与用户即将收到的
 * 429 完全对齐。真要单独统计「提交了几次口令」，数 `system.access.unlock_failed` 这个
 * `type` 的行数即可，那才是本文件写出来的那一批。
 */

/** 解锁成功。落 `info`，它是那串失败记录的**收尾**，没有它就分不清「试成了」和「放弃了」。 */
export function unlockSucceededRecord(): AuditRecordInput {
  return {
    category: 'system',
    type: 'system.access.unlocked',
    actor: 'user',
    summary: '访问口令校验通过，已解锁',
    outcome: 'ok',
  };
}

/**
 * 一次口令错误（尚未触发锁定）。
 *
 * `errorCode` 挂 10 §6.8 的 `PASSCODE_INVALID`，与用户当时收到的信封同一个码 ——
 * 不把码拼进 `summary` 散文（`AuditRecordInput.errorCode` 的纪律）。
 */
export function unlockFailedRecord(outcome: PasscodeFailureOutcome): AuditRecordInput {
  return {
    category: 'system',
    type: 'system.access.unlock_failed',
    severity: 'warn',
    actor: 'user',
    summary: `访问口令错误（连续第 ${String(outcome.consecutiveFailures)} 次，满 ${String(
      outcome.maxFailures,
    )} 次锁定）`,
    detail: {
      consecutiveFailures: outcome.consecutiveFailures,
      maxFailures: outcome.maxFailures,
    },
    outcome: 'failed',
    errorCode: 'PASSCODE_INVALID',
  };
}

/**
 * 达到阈值、门被锁上。**单独一行且是 `error` 级**，不是把标记塞进上一条的 detail：
 * 运维扫审计面板时按 severity 筛，「门被锁过」必须是**扫得到**的那一档，而不是要展开
 * 某一条 `warn` 的 detail 才看得见。
 */
export function accessLockedRecord(outcome: PasscodeFailureOutcome): AuditRecordInput {
  return {
    category: 'system',
    type: 'system.access.locked',
    severity: 'error',
    actor: 'user',
    summary: `访问口令连续错误 ${String(outcome.consecutiveFailures)} 次，已锁定 ${String(
      outcome.lockedForSec,
    )} 秒`,
    detail: {
      consecutiveFailures: outcome.consecutiveFailures,
      lockedForSec: outcome.lockedForSec,
    },
    outcome: 'failed',
    errorCode: 'PASSCODE_LOCKED',
  };
}

/**
 * 锁定期内又来了一次。
 *
 * ⚠️ **这一条不能省，它和「失败一次」说的不是同一件事。** 被锁之后还在敲的，不会是
 * 记错口令的自己人（界面直接告诉他还要等多少秒），而是没在看响应的脚本。它是
 * 「有人正在爆破」最硬的那个信号，也是唯一能看出**锁定窗口里还撞了多少下**的记录 ——
 * 这些尝试压根不进 limiter 的计数（controller 在查锁定时就抛了），不记就彻底没有。
 */
export function lockedAttemptRecord(lockedForSec: number): AuditRecordInput {
  return {
    category: 'system',
    type: 'system.access.locked_attempt',
    severity: 'warn',
    actor: 'user',
    summary: `锁定期内再次提交访问口令，剩余 ${String(lockedForSec)} 秒`,
    detail: { lockedForSec },
    outcome: 'failed',
    errorCode: 'PASSCODE_LOCKED',
  };
}

/**
 * 口令本身被启用 / 重新生成 / 关闭（`PUT /api/system/access-passcode`）。
 *
 * ⚠️ **这一条比上面四条更该有，而它此前不存在。** 上面四条记的是「有人在门上试」；
 * 这一条记的是「门锁本身被换掉了」——包括 `disable` 那次，也就是**平台从此对任何人
 * 敞开**的那一刻。没有它，事后唯一能看出的只有 `system_settings` 的一个时间戳，
 * 而那一列会被下一次操作原地覆盖，`disable` 更是把它清成 NULL：**关掉口令这件事
 * 不留任何痕迹**。
 *
 * `disable` 落 `error` 级、另外两个落 `info`：运维筛「仅告警」时，要扫得到的是
 * 「防护被关了」，而不是「防护被开了」。
 *
 * ⛔ 与上面四条同一条纪律：**签名里没有口令参数**，所以这里不可能记进明文/前缀/长度。
 */
export function passcodeChangedRecord(
  action: 'enable' | 'regenerate' | 'disable',
): AuditRecordInput {
  const summary = {
    enable: '已启用访问口令（新口令仅在本次响应中回显一次）',
    regenerate: '已重新生成访问口令，旧口令即刻失效（已通过的会话不受影响）',
    disable: '已关闭访问口令，此后任何人可访问本实例',
  }[action];
  return {
    category: 'system',
    type: 'system.access.passcode_changed',
    severity: action === 'disable' ? 'error' : 'info',
    actor: 'user',
    summary,
    detail: { action },
    outcome: 'ok',
  };
}
