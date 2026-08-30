import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { AUDIT_RECORDER } from '@platform/contracts';
import type {
  AuditRecorder,
  ConnectivityResult,
  InitRequest,
  InitStatusDto,
} from '@platform/contracts';
import { ConnectivityProbe } from './diagnostics/connectivity.probe';
import { DIAGNOSE_TIMEOUT_MS } from './diagnostics/diagnostics.service';
import { SystemSettingsService } from './system-settings.service';
import { redactProxyConfig } from './proxy-redaction';

/**
 * `POST /api/system/init` —— 初始化向导的落点（P21-8 §2）。
 *
 * ── 一次性，不幂等 ──────────────────────────────────────────────────────────
 * ⚠️ 已初始化 → **409**（10 §6.6，审计 P2-4）。写成幂等（重复调用返回 200）看起来更
 * 「友好」，代价是**平台再也说不出「这台机器是什么时候开出来的」**：`initializedAt`
 * 会被每一次误调重写，而那正是日后排查里问得到、现在答不出的那个问题
 * （13 §2.8.2 对 `system.initialized` 的原话）。
 *
 * ── ★ 两种 409 是**两个码**，不是一个 ─────────────────────────────────────
 * 这条路上有两种 409：**已经初始化过了**（`ALREADY_INITIALIZED`）与**模型 API 全挂且没带
 * `acknowledgeOffline`**（`OFFLINE_NOT_ACKNOWLEDGED`）。
 *
 * ⛔ 它们**曾经共用 `INVALID_STATE`**，而调用方要做的事恰好相反：前者「目标状态已达成 ⇒
 * 放行进工作台」，后者「平台一个字都没写 ⇒ 必须留在向导里让用户看见那句话」。同一个码
 * 表达两件需要不同处理的事，等于逼每个调用方**再打一次 `GET /init-status` 去二次探测**
 * 才知道自己拿到的是哪一种 —— 而照着「409 = 已初始化」直接放行的那一版（F21-8 §8 约束 3
 * 的原文）会把一台**根本没初始化**的机器放进工作台：用户看到工作台、下次刷新又被弹回
 * 向导，**中间一句错误都没有**。
 *
 * ⚠️ 加码的代价（10 §6.8 那张表 + A5 门禁）是**一次性**的；二次探测的代价是**每个调用方
 * 每一次**。这与四个 `PRESET_IMAGE_*` 不许合成一条「镜像不可用」是同一条纪律。
 *
 * ── 它与 `PUT /api/system/settings` 的分工 ──────────────────────────────────
 * `/init` 是**放行**（写 `initialized=true`，此后不再出现向导）；`PUT /settings` 只
 * **存配置**。两条路都能写代理，但只有这一条会放行 —— 见
 * `SystemSettingsService.update()` 的注释。
 */
@Injectable()
export class InitializationService {
  constructor(
    private readonly settings: SystemSettingsService,
    private readonly probe: ConnectivityProbe,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  async initialize(req: InitRequest): Promise<InitStatusDto> {
    if (this.settings.initialized()) {
      // ⚠️ `sideEffectFree: true` 是**由构造断言**的：这一步在任何写之前，库一个字都没动。
      //    前端据此把它渲染成「就地改请求」而不是「重试」（10 §6.8）。
      throw new ConflictException({
        code: 'ALREADY_INITIALIZED',
        message:
          '平台已经初始化过了。初始化是一次性操作 —— 要改代理等运行期配置请用 PUT /api/system/settings（系统状态页），它不会重放初始化。',
        retryable: false,
        sideEffectFree: true,
      });
    }

    // 出网检测**复用 `/diagnose` 那一套**（10 §6.6 / P21-8 §2）。用户刚在向导里填的
    // 代理还没落库，所以按他填的那份测 —— 不然 [重新检测] 测的永远是上一次的配置。
    const controller = new AbortController();
    const connectivity = await this.probe.run({
      timeoutMs: DIAGNOSE_TIMEOUT_MS,
      signal: controller.signal,
      ...(req.proxyConfig === undefined ? {} : { proxyOverride: req.proxyConfig }),
    });

    this.assertOfflineAcknowledged(connectivity, req.acknowledgeOffline ?? false);

    this.settings.markInitialized(req.proxyConfig, connectivity);
    this.recordAudit(req, connectivity);
    return this.settings.initStatus();
  }

  /**
   * 模型 API 全挂时必须**显式确认**才放行（P21-8 §1 的物理约束）。
   *
   * ⚠️ 不设这道门的话，一个离线部署会一路走完向导，直到用户建完项目、配完凭证、点下
   * [发起] 才发现 Agent 从一开始就不可用 —— 与第 ⑧ 项要修的是同一种「最晚最挫败的
   * 时机」。而**镜像仓库不可达不在这道门里**：那只是拉不到新镜像，不是 Agent 不可用。
   *
   * ⚠️ 这不是「拒绝离线部署」：带上 `acknowledgeOffline: true` 就照常放行（P21-8 §2：
   * 「仍可[继续]」）。门的作用是保证那句话**被说出来过**。
   */
  private assertOfflineAcknowledged(
    connectivity: readonly ConnectivityResult[],
    acknowledged: boolean,
  ): void {
    const modelApis = connectivity.filter((r) => r.modelApi);
    const offline = modelApis.length > 0 && modelApis.every((r) => !r.ok);
    if (!offline || acknowledged) return;
    throw new ConflictException({
      code: 'OFFLINE_NOT_ACKNOWLEDGED',
      message:
        `模型 API 全部不可达（${modelApis.map((r) => r.target).join('、')}）—— 当前为离线环境，Agent 将不可用。` +
        '配置代理后重新检测，或带 acknowledgeOffline: true 明确以离线模式继续（平台其余功能可用）。',
      retryable: false,
      sideEffectFree: true,
      details: modelApis.map((r) => ({
        path: r.target,
        message: r.hint ?? '不可达',
      })),
    });
  }

  /**
   * `system.initialized` 审计（13 §2.8.2，本轮从 ⏳ 落地）。
   *
   * 它回答的是：**谁在什么时候完成了初始化、当时选了什么代理**。前两问在单机私有化
   * 部署里没有用户体系（11 §3.1），所以 actor 恒 `user`、「谁」只能到此为止；
   * 「什么时候」由 `at` 列回答；「选了什么代理」由 detail 回答 —— 而它必须脱敏。
   *
   * ⛔ **代理里可能含凭证**（`http://user:pass@host`），而两道既有防线都接不住它：
   * `log-redactor` 认的是密钥形状，**URL userinfo 一条规则都不遮**；`audit-redaction`
   * 的键名黑名单里也没有 `httpProxy`。所以脱敏必须发生在**这里**，进 `record()` 之前
   * （写入口脱敏，13 §2.8.2）。本仓在 `ProjectConvertedToEmpty` 上踩过同一个坑，
   * 那次的解法就是只记 host —— 这里沿用（见 `proxy-redaction.ts`）。
   */
  private recordAudit(req: InitRequest, connectivity: readonly ConnectivityResult[]): void {
    const offlineAck = req.acknowledgeOffline === true;
    this.audit.record({
      category: 'system',
      type: 'system.initialized',
      severity: offlineAck ? 'warn' : 'info',
      actor: 'user',
      outcome: 'ok',
      summary: offlineAck
        ? '完成平台初始化（以离线模式继续：模型 API 不可达，Agent 不可用）'
        : '完成平台初始化',
      detail: {
        ...redactProxyConfig(req.proxyConfig),
        acknowledgeOffline: offlineAck,
        connectivity: connectivity.map((r) => ({ target: r.target, ok: r.ok })),
      },
    });
  }
}
