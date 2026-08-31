import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { EVENT_BUS } from '@platform/shared-kernel';
import type { DomainEvent, EventBus } from '@platform/shared-kernel';
import {
  AUDIT_RECORDER,
  type AuditActor,
  type AuditRecorder,
  type AuditRecordInput,
} from '@platform/contracts';
import {
  SandboxCreated,
  SandboxStateChanged,
  SandboxReconciledAsOrphan,
  AgentTaskStarted,
  AgentTaskFinished,
} from '@platform/sandbox';
import { CredentialStored, CredentialRevoked, CredentialInjected } from '@platform/credential';
import {
  ProjectBaselineSynced,
  ProjectCloneCancelled,
  ProjectCloneRetried,
  ProjectConvertedToEmpty,
  ProjectCreated,
  ProjectDeleted,
  VolumeRetained,
} from '@platform/project';
import { RuntimeAuthModeChanged, RuntimeInstallationStateChanged } from '@platform/runtime';
import {
  ImageActivated,
  ImageConfigUpdated,
  ImageDeactivated,
  ImageDeleted,
  ImageRegistered,
  ImageValidated,
} from '@platform/image';

/**
 * 审计流的**写入口 ①**（13 §2.8.2「写入语义：两个入口」）：订阅 `EventBus`，把
 * 业务事实投影成 `audit_events` 行。
 *
 * ⚠️ **这天然就是事务外的，不需要为审计额外设计事务边界。** `InProcessEventBus.
 * publishInTx` 只是内存缓冲，`queueMicrotask` 在 better-sqlite3 事务**提交之后**才
 * flush，而且 flush 里的 `try/catch` 保证「抛异常的订阅者永远无法回滚业务写」。
 *
 * ⚠️ **它覆盖不了失败路径 —— 那是入口 ② 存在的全部理由。** 业务失败时聚合不会
 * `publish`，projector 什么也收不到；而排障需要的恰恰是失败那一刻。技术过程（阶段
 * 耗时、探测输出）同理，见 `AuditRecorder` 的接口注释。
 *
 * ⚠️ **认不出的事件一律跳过，不落一行「未知事件」。** 审计面板是给产品用户看的
 * （P21-5 §10.1），一屏 `UnknownEvent` 只会让人第一次点开就再也不点第二次；
 * 而且那等于把运行日志灌进审计面板，正是 P21-5 §10.1 明令不要做的事。
 */
@Injectable()
export class AuditProjector implements OnApplicationBootstrap {
  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  onApplicationBootstrap(): void {
    this.events.subscribe((batch) => this.onEvents(batch));
  }

  private onEvents(batch: DomainEvent[]): void {
    for (const event of batch) {
      const record = project(event);
      if (record) this.audit.record(record);
    }
  }
}

/**
 * 领域事件 → 审计行。**导出成纯函数**，这样它可以脱离 Nest 容器被逐条断言 ——
 * projector 本身只剩「订阅 + 转发」两行，没有值得测的分支。
 */
export function project(e: DomainEvent): AuditRecordInput | null {
  if (e instanceof SandboxCreated) {
    return {
      category: 'sandbox',
      type: 'sandbox.created',
      subjectType: 'sandbox',
      subjectId: e.sandboxId,
      actor: 'user',
      summary: `创建沙箱 ${e.name}`,
      detail: { projectId: e.projectId },
    };
  }

  if (e instanceof SandboxStateChanged) {
    const failed = e.to === 'failed';
    return {
      category: 'sandbox',
      // 03 §7.8 的清单名。⚠️ 不是 WS 投影名 `sandbox.status_changed` —— 审计的 type
      // 是它自己的词汇表，跟着 03 §7.8 走。
      type: 'sandbox.state_changed',
      severity: failed ? 'error' : 'info',
      subjectType: 'sandbox',
      subjectId: e.sandboxId,
      // 「谁推动的」= transition 的 triggeredBy，不是笼统的 'system'（13 §2.8.2：
      // actor 是排障第一个要问的）。经 `transitionActor()` 透传 —— 那是 actor 取值集合
      // 的编译期钉子，见函数注释。
      actor: transitionActor(e.triggeredBy),
      summary: `沙箱状态 ${e.from} → ${e.to}`,
      detail: { from: e.from, to: e.to },
      outcome: failed ? 'failed' : 'ok',
      ...(e.errorCode === undefined ? {} : { errorCode: e.errorCode }),
    };
  }

  if (e instanceof SandboxReconciledAsOrphan) {
    return {
      category: 'sandbox',
      // 03 §7.8 的清单名。
      type: 'sandbox.reconciled_orphan',
      // ⚠️ `warn` 而不是 `error`：平台自己把账本改对了，没有任何东西坏掉；但一个
      // 「库里写着 running、实例其实没了」的沙箱是需要人知道的事实。
      severity: 'warn',
      subjectType: 'sandbox',
      subjectId: e.sandboxId,
      // 13 §2.8.2：actor 是排障第一个要问的。对账既不是用户也不是调度器推动的
      // —— `AUDIT_ACTORS` 里对应「平台自己」的那个值是 `system`。
      actor: 'system',
      summary: `对账判定沙箱 ${e.name} 的实例已不存在，已释放其配额`,
      // ⚠️ `status` 记的是**当时**的状态，而这次对账**不会**改它（13 §4 已按实现回填）。
      // 读的人看到 `running` 才明白这条记录在说什么。
      detail: { projectId: e.projectId, status: e.status, reason: e.reason },
      outcome: 'ok',
    };
  }

  if (e instanceof AgentTaskStarted) {
    return {
      category: 'sandbox',
      type: 'sandbox.task.started',
      subjectType: 'sandbox',
      subjectId: e.sandboxId,
      actor: 'user',
      summary: `启动无头任务（${e.runtime}）`,
      // ⚠️ prompt 不进 detail：它最长 8000 字符的用户内容，且 `AgentTaskStarted` 本身
      // 就刻意不携带它（agent-task-events.ts 的注释）。审计要的是身份，不是正文。
      detail: {
        taskId: e.taskId,
        runtime: e.runtime,
        continuation: e.resumedFrom !== undefined,
      },
    };
  }

  if (e instanceof AgentTaskFinished) {
    const ok = e.status === 'succeeded';
    return {
      category: 'sandbox',
      type: 'sandbox.task.finished',
      severity: ok ? 'info' : 'warn',
      subjectType: 'sandbox',
      subjectId: e.sandboxId,
      actor: 'system',
      summary: `无头任务结束：${e.status}`,
      detail: {
        taskId: e.taskId,
        status: e.status,
        // ⚠️ `undefined` 而不是 0：被信号杀掉的进程**没有**退出码，写 0 是在编造
        // 一次「正常退出」。
        ...(e.exitCode === undefined ? {} : { exitCode: e.exitCode }),
      },
      outcome: ok ? 'ok' : 'failed',
    };
  }

  if (e instanceof ProjectCreated) {
    return {
      category: 'project',
      type: 'project.created',
      subjectType: 'project',
      subjectId: e.projectId,
      actor: 'user',
      summary: `创建项目 ${e.name}`,
    };
  }

  if (e instanceof ProjectCloneRetried) {
    return {
      ...projectSubject(e),
      type: 'project.clone_retried',
      summary: `重试克隆项目 ${e.name}`,
    };
  }

  if (e instanceof ProjectConvertedToEmpty) {
    return {
      ...projectSubject(e),
      type: 'project.converted_to_empty',
      // 不可逆：`repoUrl` / `repoBranch` 归零，半份克隆被 rm -rf（23 §6.4）。
      severity: 'warn',
      summary: `项目 ${e.name} 放弃远端，转为空项目`,
      // ⛔ 只有 host，没有整条 URL —— 理由在 `ProjectConvertedToEmpty.discardedRepoHost`。
      ...(e.discardedRepoHost === null
        ? {}
        : { detail: { discardedRepoHost: e.discardedRepoHost } }),
    };
  }

  if (e instanceof ProjectCloneCancelled) {
    return {
      ...projectSubject(e),
      type: 'project.clone_cancelled',
      severity: 'warn',
      summary: `取消克隆项目 ${e.name}`,
      // 「有人按了停止」与「网线被拔了」在事后分不开，除非这一行在案（03 §8.3 同源）。
      outcome: 'skipped',
    };
  }

  if (e instanceof ProjectBaselineSynced) {
    return {
      ...projectSubject(e),
      type: 'project.baseline_synced',
      summary: `同步项目 ${e.name} 的基线`,
      detail: { baselineSizeBytes: e.baselineSizeBytes },
    };
  }

  if (e instanceof ProjectDeleted) {
    return {
      ...projectSubject(e),
      type: 'project.deleted',
      severity: 'warn',
      summary: `删除项目 ${e.name}`,
      detail: { keptBaseline: e.keptBaseline },
    };
  }

  if (e instanceof VolumeRetained) {
    return {
      category: 'project',
      type: 'project.volume_retained',
      subjectType: 'retained_volume',
      subjectId: e.volumeId,
      actor: 'user',
      // ⛔ summary 里不出现宿主路径（部署布局），也不出现 UUID 之外的定位信息 ——
      // 两个大小才是用户看这一行要的：删掉能拿回多少 / 下载要拉多少。
      summary: `保留工作区卷（磁盘 ${e.diskBytes} 字节 / 下载 ${e.downloadBytes} 字节）`,
      detail: {
        projectId: e.projectId,
        sandboxId: e.sandboxId,
        retainUntil: e.retainUntil.toISOString(),
        diskBytes: e.diskBytes,
        downloadBytes: e.downloadBytes,
      },
    };
  }

  if (e instanceof ImageRegistered) {
    return {
      ...imageSubject(e),
      type: 'image.registered',
      summary: `注册镜像 ${e.ref}`,
      // digest 不是 UUID 而是这一行的身份（I-IMG-6），它属于 detail 不属于 summary。
      detail: { digest: e.digest, imageId: e.imageId },
    };
  }

  if (e instanceof ImageValidated) {
    return {
      ...imageSubject(e),
      type: 'image.validated',
      severity: e.status === 'invalid' ? 'error' : e.status === 'warning' ? 'warn' : 'info',
      summary: `校验镜像 ${e.ref}：${e.status}`,
      detail: { status: e.status },
      outcome: e.status === 'invalid' ? 'failed' : 'ok',
    };
  }

  if (e instanceof ImageActivated) {
    return {
      ...imageSubject(e),
      type: 'image.activated',
      summary: `启用镜像 ${e.ref}`,
    };
  }

  if (e instanceof ImageDeactivated) {
    return {
      ...imageSubject(e),
      type: 'image.deactivated',
      // 「谁把生产镜像停用了」—— 这一档审计存在的理由，必须是筛 severity 时扫得到的。
      severity: 'warn',
      summary: `停用镜像 ${e.ref}`,
    };
  }

  if (e instanceof ImageConfigUpdated) {
    return {
      ...imageSubject(e),
      type: 'image.config_updated',
      summary: `修改镜像 ${e.ref} 的运行参数`,
      // ⛔ env 的键值一律不进：04 §2.3★ 记着 env 会被物化成 `export K=V` 拼进命令串。
      // 这一行只说「改过」，改成什么是 `image_manifests.config` 那一列的事。
    };
  }

  if (e instanceof ImageDeleted) {
    return {
      ...imageSubject(e),
      type: 'image.deleted',
      severity: 'warn',
      summary: `删除镜像 ${e.ref}`,
    };
  }

  if (e instanceof RuntimeAuthModeChanged) {
    return {
      // 它换的是「以后所有沙箱注入哪份凭证」（05 §4.1），落在 credential 档而不是
      // sandbox —— 读者是在看凭证怎么配的那个人。
      category: 'credential',
      type: 'credential.auth_mode_changed',
      // subjectId 是 `claude-code` 这种 runtime id：它本身就是人话，没有 UUID 问题。
      subjectType: 'runtime',
      subjectId: e.runtimeId,
      actor: 'user',
      summary:
        e.from === null
          ? `设置 ${e.runtimeId} 的生效凭证方式：${e.to}`
          : `切换 ${e.runtimeId} 的生效凭证方式：${e.from} → ${e.to}`,
      detail: { runtimeId: e.runtimeId, to: e.to, ...(e.from === null ? {} : { from: e.from }) },
    };
  }

  if (e instanceof CredentialStored) {
    return {
      category: 'credential',
      type: 'credential.stored',
      subjectType: 'credential',
      subjectId: e.credentialId,
      actor: 'user',
      summary: `保存凭证 ${credentialLabel(e)}`,
    };
  }

  if (e instanceof CredentialRevoked) {
    return {
      category: 'credential',
      type: 'credential.revoked',
      severity: 'warn',
      subjectType: 'credential',
      subjectId: e.credentialId,
      actor: 'user',
      summary: `吊销凭证 ${credentialLabel(e)}`,
    };
  }

  if (e instanceof CredentialInjected) {
    return {
      category: 'credential',
      type: 'credential.injected',
      // subject 是**沙箱**而不是凭证：这条记录的读者在看「这个沙箱经历了什么」
      // （P21-5 §10.2 的沙箱时间线按 subjectId 筛）。凭证 id 放 detail。
      subjectType: 'sandbox',
      subjectId: e.sandboxId,
      actor: 'system',
      summary: `向沙箱注入运行时凭证`,
      detail: { credentialId: e.credentialId },
    };
  }

  if (e instanceof RuntimeInstallationStateChanged) {
    const failed = e.status === 'failed';
    return {
      category: 'sandbox',
      type: 'sandbox.runtime_install',
      severity: failed ? 'error' : 'info',
      subjectType: 'sandbox',
      subjectId: e.sandboxId,
      actor: 'system',
      summary: `${e.runtimeId} 安装状态：${e.status}`,
      detail: {
        runtimeId: e.runtimeId,
        status: e.status,
        ...(e.versionDetected === undefined ? {} : { versionDetected: e.versionDetected }),
        ...(e.error === undefined ? {} : { error: e.error }),
      },
      ...(failed ? { outcome: 'failed' as const } : {}),
    };
  }

  return null;
}

/**
 * project 类事件共用的三件套。**抽出来是为了让它们不可能各写各的**：`subjectType`
 * 写歪一个，P21-5 §10.2 的项目时间线就少一条，而那种缺失在任何断言里都不会红。
 */
function projectSubject(e: {
  projectId: string;
}): Pick<AuditRecordInput, 'category' | 'subjectType' | 'subjectId' | 'actor'> {
  return { category: 'project', subjectType: 'project', subjectId: e.projectId, actor: 'user' };
}

/**
 * image 类事件共用的三件套（理由同 `projectSubject`）。
 *
 * ⚠️ `subjectId` 是 **manifestId**（UUID），`summary` 里的是 `ref` —— 两者各归各位，
 * 正是 13 §2.8.2「id 仍然查得到，它属于 subject_id 那一列，不属于给人看的那一行」。
 */
function imageSubject(e: {
  manifestId: string;
}): Pick<AuditRecordInput, 'category' | 'subjectType' | 'subjectId' | 'actor'> {
  return { category: 'image', subjectType: 'image', subjectId: e.manifestId, actor: 'user' };
}

/**
 * 凭证在审计行上的**人话标识**：`claude-code（oauth-device）` / `Git（ssh-key）`。
 *
 * 凭证**没有用户起的名字**，能认人的只有「哪个 runtime + 什么获取方式」这个组合。
 * 写 id 的那一版在真实面板上是「保存凭证 3f9a77c1-8b04-…」——用户认不出自己刚存的是
 * 哪一个，那一行实际只说了「有个凭证被存了」。
 *
 * ⛔ **这一列绝不能带密文、token 片段或 `MaskedIdentifier`（SSH 指纹 / token 末四位）。**
 * `summary` 与 `detail` 同受 05 §4 脱敏纪律约束，而末四位是能反推凭证内容的东西。
 * 事件上压根没带这些字段，纪律因此在**源头**成立，不靠这里记得删。
 *
 * `runtimeId` 为空即 git 凭证（I-CRD-1：`kind='git'` ⇒ `runtimeId` 恒为 null），所以事件
 * 不必再多带一个 `kind`。git 半区的 `obtainedVia` 自带 `git-` 前缀，去掉它才不会读成
 * 「Git（git-ssh-key）」——**去前缀而不是查一张映射表**：映射表会是同一个闭集的第三份
 * 手抄，而本文件底部 `transitionActor()` 的注释记的正是手抄漂移的代价。
 */
function credentialLabel(e: CredentialStored | CredentialRevoked): string {
  return `${e.runtimeId ?? 'Git'}（${e.obtainedVia.replace(/^git-/, '')}）`;
}

/**
 * `SandboxStateChanged.triggeredBy` **原样透传**成审计的 `actor`。
 *
 * ⚠️ **这个函数唯一的作用是那条返回类型标注**，它是 actor 取值集合的编译期钉子。
 * 本行是 `scheduler` / `health-check` / `provider-event` 这些 actor 的**唯一**产地
 * （其余调用点写的都是字面量 `'user'` / `'system'`）。此前 `AUDIT_ACTORS` 与它漂移过：
 * 常量里写着后端一处都不写的 `mcp` / `automation`，而后端每次 provision 都在写的
 * `scheduler` 之外，`health-check` / `provider-event` 一个都不在清单里 —— 前端按清单
 * 做的 `ACTOR_LABELS` 因此在中文界面上漏出英文标识符，而没有任何测试会红。
 * 现在 `AUDIT_ACTORS` 由 `TRIGGERED_BY` 派生，`TriggeredBy` 再多一个值时，**这一行会
 * 编译不过** —— 那正是「前端要补一条 label」的时刻。
 */
function transitionActor(by: SandboxStateChanged['triggeredBy']): AuditActor {
  return by;
}
