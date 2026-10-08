import type { ResourceQuota } from './sandbox-provider.contract';

/**
 * 平台自己持有、**不进 `sandboxes` 表**的固定实例 —— 目前只有一个：帐号登录用的
 * auth helper（11 §1.1 的常驻 helper）。
 *
 * ── 为什么放在 contracts ──────────────────────────────────────────────────────
 * helper 由 runtime 模块创建（`HelperContainerSession`），启动对账却在 sandbox 模块
 * （`RuntimeReconciler`）。两边必须认**同一个** sandboxId，而 boundaries 只允许
 * infrastructure 依赖本模块与 contracts / shared-kernel，两个包之间也互不依赖 ⇒
 * 这个词只能住在这里。任务沙箱的 id 一律是 UUID（`uuid-id-generator.ts`），不会与它相撞。
 *
 * ⛔ 主仓部署探针（`deploy/containers/api-container.mjs` 的 STOPPED_RESERVATIONS_PROBE）
 *    硬编码了同一个字面量（`prefix + "auth-helper"`），并要求稳态下**恰好一个**这个名字的
 *    running box。改这里就必须同时改那边，否则下一次发版会一直停在 waiting-idle。
 */
export const AUTH_HELPER_SANDBOX_ID = 'auth-helper';

/** 这个 sandboxId 是不是平台自己持有的固定实例（而不是某个任务沙箱）。 */
export function isPlatformOwnedSandboxId(sandboxId: string): boolean {
  return sandboxId === AUTH_HELPER_SANDBOX_ID;
}

/**
 * 平台常驻实例在调度池里的预留（03 §1 资源池）。
 *
 * ⚠️ **它从池子总量里扣，⛔ 绝不写 `resource_allocations` / `sandboxes`。** 三个理由，
 *    缺一不可：`resource_allocations.sandbox_id` 有外键指向 `sandboxes`；未释放的登记会让
 *    `/api/deployment/status` 永远判不空闲；发版探针要求每条未释放登记都对应一个 stopped
 *    的任务沙箱。账本只记任务，平台常驻的占用走这里。
 */
export interface PlatformReservation {
  /** 谁占的 —— 排障用的标识，例如 {@link AUTH_HELPER_SANDBOX_ID}。 */
  readonly owner: string;
  /** 给人看的名字，写进容量说明（`basis`）。 */
  readonly label: string;
  readonly quota: ResourceQuota;
}

/**
 * DI token：`readonly PlatformReservation[]`。由持有常驻实例的模块提供（runtime），
 * 调度方（sandbox 的 `ResourceAllocator`）以 `@Optional()` 注入 —— 没人提供时就是不预留。
 */
export const PLATFORM_RESERVATIONS = Symbol('PlatformReservations');
