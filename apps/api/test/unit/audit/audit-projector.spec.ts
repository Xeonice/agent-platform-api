import { describe, it, expect } from 'vitest';
import {
  AgentTaskFinished,
  AgentTaskStarted,
  SandboxCreated,
  SandboxStateChanged,
} from '@platform/sandbox';
import { CredentialInjected, CredentialRevoked, CredentialStored } from '@platform/credential';
import {
  ProjectBaselineSynced,
  ProjectCloneCancelled,
  ProjectCloneRetried,
  ProjectConvertedToEmpty,
  ProjectCreated,
  ProjectDeleted,
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
import { AUDIT_ACTORS, TRIGGERED_BY } from '@platform/contracts';
import type { DomainEvent } from '@platform/shared-kernel';
import { project } from '../../../src/platform/audit/audit.projector';

/**
 * 写入口 ①（13 §2.8.2）：领域事件 → 审计行。
 *
 * ⚠️ 这里用**真的事件类**而不是结构字面量，是刻意的：projector 靠 `instanceof` 判别，
 * 而字段被改名时只有真类能让编译/断言变红。
 */
const AT = new Date('2026-08-27T12:00:00.000Z');

describe('AuditProjector.project', () => {
  it('SandboxStateChanged 的 actor 来自 triggeredBy，不是笼统的 system', () => {
    const reaped = project(new SandboxStateChanged('sbx-1', 'idle', 'stopping', 'reaper', AT));
    const byUser = project(new SandboxStateChanged('sbx-1', 'running', 'stopping', 'user', AT));
    // ⚠️ 「这个沙箱是自己 idle 被 reaper 收走的，还是用户按了停止」——13 §2.8.2 说
    // actor 是排障第一个要问的。两条记录必须分得开。
    expect(reaped?.actor).toBe('reaper');
    expect(byUser?.actor).toBe('user');
  });

  it('转到 failed 时是 error 级 + outcome failed + 带上错误码', () => {
    const r = project(
      new SandboxStateChanged('sbx-1', 'starting', 'failed', 'scheduler', AT, 'INSTALL_FAILED'),
    );
    expect(r).toMatchObject({
      type: 'sandbox.state_changed',
      severity: 'error',
      outcome: 'failed',
      errorCode: 'INSTALL_FAILED',
    });
  });

  it('正常流转是 info + ok，且不凭空造一个 errorCode', () => {
    const r = project(new SandboxStateChanged('sbx-1', 'creating', 'starting', 'scheduler', AT));
    expect(r?.severity).toBe('info');
    expect(r?.outcome).toBe('ok');
    expect(r && 'errorCode' in r).toBe(false);
  });

  it('CredentialInjected 的 subject 是**沙箱**，凭证 id 进 detail', () => {
    // 这条记录的读者在看「这个沙箱经历了什么」（P21-5 §10.2 的时间线按 subjectId 筛）。
    const r = project(new CredentialInjected('cred-9', 'sbx-7', AT));
    expect(r).toMatchObject({ subjectType: 'sandbox', subjectId: 'sbx-7' });
    expect(r?.detail).toMatchObject({ credentialId: 'cred-9' });
  });

  it('各上下文落到各自的 category', () => {
    expect(project(new SandboxCreated('sbx-1', 'prj-1', '我的任务', AT))?.category).toBe('sandbox');
    expect(project(new ProjectCreated('prj-1', '我的项目', AT))?.category).toBe('project');
    expect(project(new CredentialRevoked('cred-1', 'codex', 'oauth-device', AT))?.category).toBe(
      'credential',
    );
  });

  it('project.created 的 summary 写项目名,不写 UUID', () => {
    const r = project(new ProjectCreated('621510e4-d357-498f-9b87-83a2984ad051', '我的项目', AT));

    // 13 §2.8.2 对 summary 的要求是「一行人话,直接上 UI」。写 id 的那一版在真实面板上
    // 长这样:「创建项目 621510e4-d357-498f-9b87-83a2984ad051」—— 五行除了 UUID 全一样,
    // 用户认不出是哪个项目,这一行实际只说了「有个项目被建了」。
    expect(r?.summary).toBe('创建项目 我的项目');
    // ⚠️ 否定断言是这条的重点:光断言「包含项目名」的话,`创建项目 我的项目 (621510e4-…)`
    // 这种把 UUID 也拼进去的写法照样绿,而它在 UI 上和原来一样难读。
    expect(r?.summary).not.toContain('621510e4');
    // id 仍然要能查到 —— 它属于 subjectId 那一列,不属于给人看的那一行。
    expect(r?.subjectId).toBe('621510e4-d357-498f-9b87-83a2984ad051');
  });

  it('sandbox.created 的 summary 写任务名,不写 UUID', () => {
    // sandbox 类事件是审计流里**数量最多**的一类（一次 provision 就是六个阶段 + 五次状态
    // 流转），写 id 的那一版让面板整屏都是 UUID —— 用户第一次点开就再也不点第二次。
    const r = project(
      new SandboxCreated(
        '8f3c1d02-4b77-4c20-9f2e-6d1b0a5e77aa',
        'prj-1',
        '修复登录页的样式问题',
        AT,
      ),
    );

    expect(r?.summary).toBe('创建沙箱 修复登录页的样式问题');
    // ⚠️ 否定断言是这条的重点（同 project.created 那条）：光断言「包含任务名」的话，
    // `创建沙箱 修复登录页的样式问题 (8f3c1d02-…)` 这种把 UUID 也拼回去的写法照样绿。
    expect(r?.summary).not.toContain('8f3c1d02');
    // id 仍然要能查到 —— 它属于 subjectId 那一列，不属于给人看的那一行。
    expect(r?.subjectId).toBe('8f3c1d02-4b77-4c20-9f2e-6d1b0a5e77aa');
  });

  it('凭证的 summary 写「runtime + 获取方式」,不写 UUID', () => {
    // 凭证**没有用户起的名字**，能认人的只有这个组合。
    const stored = project(
      new CredentialStored(
        '3f9a77c1-8b04-4f0e-9a1d-2c5e8f0b7d31',
        'claude-code',
        'oauth-device',
        AT,
      ),
    );
    const revoked = project(
      new CredentialRevoked('3f9a77c1-8b04-4f0e-9a1d-2c5e8f0b7d31', 'claude-code', 'api-key', AT),
    );

    expect(stored?.summary).toBe('保存凭证 claude-code（oauth-device）');
    expect(revoked?.summary).toBe('吊销凭证 claude-code（api-key）');
    // ⚠️ 否定断言：把 id 也拼进去的写法在「包含 runtime 名」下照样绿。
    expect(stored?.summary).not.toContain('3f9a77c1');
    expect(revoked?.summary).not.toContain('3f9a77c1');
    expect(stored?.subjectId).toBe('3f9a77c1-8b04-4f0e-9a1d-2c5e8f0b7d31');
  });

  it('git 凭证没有 runtimeId,读作 Git(方式)——不读成 null,也不读成 Git(git-…)', () => {
    const ssh = project(new CredentialStored('cred-1', null, 'git-ssh-key', AT));
    const https = project(new CredentialRevoked('cred-2', null, 'git-https-token', AT));

    expect(ssh?.summary).toBe('保存凭证 Git（ssh-key）');
    expect(https?.summary).toBe('吊销凭证 Git（https-token）');
    // ⚠️ `runtimeId` 为空时最容易写出的两种坏结果，各钉一条。
    expect(ssh?.summary).not.toContain('null');
    expect(ssh?.summary).not.toContain('git-ssh-key');
  });

  it('被信号杀掉的 Task 不编造 exitCode 0', () => {
    const r = project(new AgentTaskFinished('tsk-1', 'sbx-1', 'killed', undefined, AT));
    expect(r?.detail && 'exitCode' in r.detail).toBe(false);
    expect(r?.outcome).toBe('failed');
  });

  /**
   * ⚠️ 认不出的事件**跳过**，不落一行「未知事件」。审计面板是给产品用户看的
   * （P21-5 §10.1），一屏 UnknownEvent 等于把运行日志灌进审计面板。
   */
  it('认不出的事件返回 null', () => {
    const stranger: DomainEvent = { type: 'SomethingNobodyMapped', occurredAt: AT };
    expect(project(stranger)).toBeNull();
  });
});

/**
 * image 档 —— **此前 projector 一条分支都没有**，而 `image-events.ts` 的五个事件真的
 * 在 raise。7 个改动型端点（注册 / 改配置 / 启用 / 停用 / 删除 …）因此全部无痕，
 * 「谁把生产镜像停用了」答不出来。
 */
describe('image 档：summary 写用户认得的 ref，不写 manifestId', () => {
  const MID = '8f3c1d02-4b77-4c20-9f2e-6d1b0a5e77aa';
  const REF = 'registry.local/platform/sandbox:v2';

  it('五个事件 + 删除都落在 category=image，且 subjectId 是 manifestId', () => {
    const rows = [
      project(new ImageRegistered(MID, 'img-1', REF, 'sha256:abc', AT)),
      project(new ImageValidated(MID, REF, 'valid', AT)),
      project(new ImageActivated(MID, REF, AT)),
      project(new ImageDeactivated(MID, REF, AT)),
      project(new ImageConfigUpdated(MID, REF, AT)),
      project(new ImageDeleted(MID, REF, AT)),
    ];
    // 每一条都必须被认出来（否则下面的断言对着一堆 null 空转）。
    expect(rows.every((r) => r !== null)).toBe(true);
    for (const r of rows) {
      expect(r?.category).toBe('image');
      // id 仍然查得到 —— 它属于 subjectId 那一列，不属于给人看的那一行（13 §2.8.2）。
      expect(r?.subjectId).toBe(MID);
      expect(r?.subjectType).toBe('image');
    }
  });

  it('每一条 summary 都含 ref 且**不含** manifestId', () => {
    const rows = [
      project(new ImageRegistered(MID, 'img-1', REF, 'sha256:abc', AT)),
      project(new ImageValidated(MID, REF, 'valid', AT)),
      project(new ImageActivated(MID, REF, AT)),
      project(new ImageDeactivated(MID, REF, AT)),
      project(new ImageConfigUpdated(MID, REF, AT)),
      project(new ImageDeleted(MID, REF, AT)),
    ];
    for (const r of rows) {
      expect(r?.summary).toContain(REF);
      // ⚠️ 否定断言是这一条的重点：光断言「包含 ref」的话，
      // `停用镜像 registry.local/…:v2 (8f3c1d02-…)` 这种把 UUID 也拼回去的写法照样绿。
      expect(r?.summary).not.toContain('8f3c1d02');
    }
  });

  it('停用与删除分得开，且都是扫 severity 时看得见的那一档', () => {
    const off = project(new ImageDeactivated(MID, REF, AT));
    const gone = project(new ImageDeleted(MID, REF, AT));
    // 停用只是移出选项列表，历史引用照旧合法（I-IMG-3）；删除是坐标从平台上消失。
    // 事后分不清是哪一种，排查方向完全相反。
    expect(off?.type).toBe('image.deactivated');
    expect(gone?.type).toBe('image.deleted');
    expect(off?.severity).toBe('warn');
    expect(gone?.severity).toBe('warn');
  });

  it('校验结果的三级各自落到自己的 severity（invalid 才是 error）', () => {
    expect(project(new ImageValidated(MID, REF, 'valid', AT))?.severity).toBe('info');
    expect(project(new ImageValidated(MID, REF, 'warning', AT))?.severity).toBe('warn');
    expect(project(new ImageValidated(MID, REF, 'invalid', AT))?.severity).toBe('error');
    expect(project(new ImageValidated(MID, REF, 'invalid', AT))?.outcome).toBe('failed');
  });

  it('改运行参数只说「改过」，不把 env 的键值写进审计行', () => {
    // 04 §2.3★：env 会被物化成 `export K=V` 拼进命令串。改成什么是
    // `image_manifests.config` 那一列的事，不是审计行的事。
    const r = project(new ImageConfigUpdated(MID, REF, AT));
    expect(r?.detail).toBeUndefined();
  });
});

/**
 * project 档的改动型操作 —— retry-clone / convert-to-empty / cancel-clone / sync
 * 四个 POST 加上 `DELETE /api/projects/:id`，此前**一个事件都不发**。
 */
describe('project 档：四个改动型 POST + 删除', () => {
  const PID = '621510e4-d357-498f-9b87-83a2984ad051';
  const NAME = '我的项目';

  it('五种操作各有自己的 type，且都落在 category=project / subjectId=项目 id', () => {
    const rows = {
      retried: project(new ProjectCloneRetried(PID, NAME, AT)),
      converted: project(new ProjectConvertedToEmpty(PID, NAME, 'github.com', AT)),
      cancelled: project(new ProjectCloneCancelled(PID, NAME, AT)),
      synced: project(new ProjectBaselineSynced(PID, NAME, 4096, AT)),
      deleted: project(new ProjectDeleted(PID, NAME, false, AT)),
    };
    expect(rows.retried?.type).toBe('project.clone_retried');
    expect(rows.converted?.type).toBe('project.converted_to_empty');
    expect(rows.cancelled?.type).toBe('project.clone_cancelled');
    expect(rows.synced?.type).toBe('project.baseline_synced');
    expect(rows.deleted?.type).toBe('project.deleted');
    for (const r of Object.values(rows)) {
      expect(r?.category).toBe('project');
      expect(r?.subjectType).toBe('project');
      expect(r?.subjectId).toBe(PID);
    }
  });

  it('每一条 summary 都写项目名，不写 UUID', () => {
    const rows = [
      project(new ProjectCloneRetried(PID, NAME, AT)),
      project(new ProjectConvertedToEmpty(PID, NAME, 'github.com', AT)),
      project(new ProjectCloneCancelled(PID, NAME, AT)),
      project(new ProjectBaselineSynced(PID, NAME, 4096, AT)),
      project(new ProjectDeleted(PID, NAME, false, AT)),
    ];
    for (const r of rows) {
      expect(r?.summary).toContain(NAME);
      // ⚠️ 否定断言（同 project.created 那条）：把 UUID 也拼进去的写法在
      // 「包含项目名」下照样绿。
      expect(r?.summary).not.toContain('621510e4');
    }
  });

  it('convert-to-empty 只记远端 host，绝不记整条 repoUrl', () => {
    // ⛔ `RepoUrl` 刻意保留原始串，`https://user:token@host/repo.git` 会把 token 一起
    // 带进来；而 log-redactor 认的是**密钥的形状**，URL userinfo 那一段它一条都不遮。
    const r = project(new ProjectConvertedToEmpty(PID, NAME, 'github.com', AT));
    expect(r?.detail).toEqual({ discardedRepoHost: 'github.com' });
    // 空项目没有远端可丢弃 —— 不落一个 `null` 占位。
    expect(project(new ProjectConvertedToEmpty(PID, NAME, null, AT))?.detail).toBeUndefined();
  });

  it('取消克隆记成 skipped —— 「有人按了停止」与「网线被拔了」必须分得开', () => {
    expect(project(new ProjectCloneCancelled(PID, NAME, AT))?.outcome).toBe('skipped');
  });

  it('删除项目那一条自带项目名 —— 行已经没了，没有任何库可以回查', () => {
    const r = project(new ProjectDeleted(PID, NAME, true, AT));
    expect(r?.summary).toBe(`删除项目 ${NAME}`);
    expect(r?.detail).toEqual({ keptBaseline: true });
  });
});

/**
 * `PUT /api/runtimes/:rt/auth-mode` —— 23 §12 / 24 §214 写着 `RuntimeAuthModeChanged`，
 * 实现里此前没有。它决定**此后每一个沙箱**注入哪份凭证（05 §4.1）。
 */
describe('RuntimeAuthModeChanged：改完之后系统行为变了，得知道是谁改的', () => {
  it('切换写出 from → to 两档，落在 credential 档', () => {
    const r = project(new RuntimeAuthModeChanged('claude-code', 'account', 'api-key', AT));
    expect(r?.category).toBe('credential');
    expect(r?.type).toBe('credential.auth_mode_changed');
    expect(r?.subjectId).toBe('claude-code');
    expect(r?.summary).toBe('切换 claude-code 的生效凭证方式：account → api-key');
  });

  it('首配（from = null）读作「设置」，不读成 `null → api-key`', () => {
    const r = project(new RuntimeAuthModeChanged('codex', null, 'api-key', AT));
    expect(r?.summary).toBe('设置 codex 的生效凭证方式：api-key');
    // ⚠️ 否定断言：`from` 直接拼进散文的写法会在这里露出 `null`。
    expect(r?.summary).not.toContain('null');
    expect(r?.detail && 'from' in r.detail).toBe(false);
  });
});

/**
 * `actor` 取值集合 —— **文档、契约、后端实写此前是四份不一致的清单**。
 *
 * 摆在一起看当时的样子：13 §2.8.2 与 10 §7.3 都写 `user/system/reaper/mcp/automation`，
 * 契约 `AUDIT_ACTORS` 多一个 `scheduler`，而后端**真正写出来的**是
 * `user` / `system` / `scheduler`（provision workflow + runtime install，共 6 处）加上
 * projector 直接透传的 `triggeredBy`（5 值，含 `health-check` / `provider-event`）。
 * ⇒ 后端主力值三个不在清单里，清单里的 `mcp` / `automation` 后端一处都不写。
 * 前端 `ACTOR_LABELS` 按清单做，于是中文界面上直接漏出英文标识符，**没有任何测试会红**。
 *
 * 现在 `AUDIT_ACTORS = TRIGGERED_BY ∪ {'system'}`（派生，不是手抄），下面两条把两个
 * 方向都钉住：清单不许漏掉 projector 会透传的值，projector 也不许写出清单外的值。
 */
describe('actor 取值集合：契约清单与实写不许再漂移', () => {
  it('AUDIT_ACTORS 覆盖 TRIGGERED_BY 的每一个值（projector 是原样透传的）', () => {
    // ⚠️ 这不是同义反复：`AUDIT_ACTORS` 手抄成一串字面量时，这一条正是红的那条。
    for (const by of TRIGGERED_BY) expect(AUDIT_ACTORS).toContain(by);
    expect(AUDIT_ACTORS).toContain('system');
  });

  it('project() 对每一类事件产出的 actor 都在 AUDIT_ACTORS 里', () => {
    const events: DomainEvent[] = [
      new SandboxCreated('sbx-1', 'prj-1', '我的任务', AT),
      ...TRIGGERED_BY.map((by) => new SandboxStateChanged('sbx-1', 'idle', 'stopping', by, AT)),
      new AgentTaskStarted('tsk-1', 'sbx-1', 'claude-code', undefined, AT),
      new AgentTaskFinished('tsk-1', 'sbx-1', 'succeeded', 0, AT),
      new ProjectCreated('prj-1', '我的项目', AT),
      new CredentialStored('cred-1', 'codex', 'oauth-device', AT),
      new CredentialRevoked('cred-1', 'codex', 'oauth-device', AT),
      new CredentialInjected('cred-1', 'sbx-1', AT),
      new RuntimeInstallationStateChanged(
        'sbx-1',
        'claude-code',
        'installed',
        undefined,
        undefined,
        AT,
      ),
      new RuntimeAuthModeChanged('claude-code', 'account', 'api-key', AT),
      new ProjectCloneRetried('prj-1', '我的项目', AT),
      new ProjectConvertedToEmpty('prj-1', '我的项目', 'github.com', AT),
      new ProjectCloneCancelled('prj-1', '我的项目', AT),
      new ProjectBaselineSynced('prj-1', '我的项目', 4096, AT),
      new ProjectDeleted('prj-1', '我的项目', false, AT),
      new ImageRegistered('img-m-1', 'img-1', 'repo/name:tag', 'sha256:abc', AT),
      new ImageValidated('img-m-1', 'repo/name:tag', 'valid', AT),
      new ImageActivated('img-m-1', 'repo/name:tag', AT),
      new ImageDeactivated('img-m-1', 'repo/name:tag', AT),
      new ImageConfigUpdated('img-m-1', 'repo/name:tag', AT),
      new ImageDeleted('img-m-1', 'repo/name:tag', AT),
    ];
    const actors = events.map((e) => project(e)?.actor);
    // 每个事件都必须被认出来（否则下面的断言会对着一堆 undefined 空转）。
    expect(actors.every((a) => a !== undefined)).toBe(true);
    for (const actor of actors) expect(AUDIT_ACTORS).toContain(actor);
  });
});
