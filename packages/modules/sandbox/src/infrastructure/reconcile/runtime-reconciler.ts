import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import type Docker from 'dockerode';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  isPlatformOwnedSandboxId,
  SANDBOX_PROVIDER_REGISTRY,
  type ProviderRegistry,
} from '@platform/contracts';
import { DATABASE } from '@platform/shared-kernel';
import { DOCKER_CLIENT } from '../providers/docker/docker.token';
import { getSharedBoxliteRuntime } from '../providers/boxlite/boxlite-runtime';
import { sandboxes } from '../persistence/schema/sandbox.sqlite';
import { INSTANCE_LABEL, boxliteNamePrefix, platformInstanceId } from './instance-id';

type Db = BetterSQLite3Database<Record<string, never>>;

/**
 * Startup orphan reconciler (docs/backend/13 §4 privileged reconciliation path).
 * A hard crash between a provider `create()` returning and the row being
 * persisted leaves a runtime entity — a docker container or a DETACHED BoxLite
 * micro-VM (which now survives process exit) with its port-forward — that has NO
 * DB record. On boot we list platform-managed runtime entities and destroy those
 * absent from the `sandboxes` table.
 *
 * Gated by `SANDBOX_RECONCILE_ON_BOOT=true` (set by the production entrypoint) so
 * it never fires during ordinary tests (which boot many throwaway apps against a
 * fresh :memory: DB — where it would otherwise treat every live entity as an
 * orphan). Never blocks startup: all failures are logged, not thrown.
 *
 * ⚠️ 平台自己持有的固定实例（auth helper，`isPlatformOwnedSandboxId`）**不进 `sandboxes`
 * 表、也不是孤儿**：此前它每次开机都被记成 `reaped ORPHAN`，而旧 helper 的清理整个靠这条
 * 误报 + 「SandboxModule 排在 RuntimeModule 之前」的模块顺序。现在单独处理 —— 只删已经
 * 停掉 / 失败的旧实例，⛔ 不碰 running / 正在创建的（那可能就是刚建好的新 helper）。
 * 另一道清理在 `HelperContainerSession` 自己的「先按名字清残留再建」里，两道互不依赖。
 * ⚠️ 例外：helper 所属的 provider 已经不是默认 provider（换过 `SANDBOX_DEFAULT_PROVIDER`）
 * ⇒ 不论状态都删。helper 只在默认 provider 上建、也只在那里按名字清，旧 provider 下那个
 * 再没有人会用、也没有人会清；此前它会被当成 ORPHAN 收掉，这里保住这一点。
 */
@Injectable()
export class RuntimeReconciler implements OnApplicationBootstrap {
  private readonly logger = new Logger('RuntimeReconciler');

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(DOCKER_CLIENT) private readonly docker: Docker,
    /** 只用来认「现在的默认 provider」；没有它（直接 new 出来的）⇒ 不做这一层判断。 */
    @Optional()
    @Inject(SANDBOX_PROVIDER_REGISTRY)
    private readonly providers?: ProviderRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.SANDBOX_RECONCILE_ON_BOOT !== 'true') return;
    try {
      await this.reconcile();
    } catch (e) {
      this.logger.warn(`startup reconcile skipped: ${(e as Error).message}`);
    }
  }

  /** Public so an operator/test can trigger a reconcile explicitly. */
  async reconcile(): Promise<{ removedContainers: number; removedBoxes: number }> {
    const known = this.knownSandboxIds();
    const removedContainers = await this.reconcileDocker(known);
    const removedBoxes = await this.reconcileBoxlite(known);
    return { removedContainers, removedBoxes };
  }

  private knownSandboxIds(): Set<string> {
    const rows = this.db
      .select({ id: sandboxes.id, handle: sandboxes.providerHandle, status: sandboxes.status })
      .from(sandboxes)
      .all();
    // A creation that crashed before its handle was saved, or an already terminal
    // task, cannot own a surviving provider instance. Stopped instances stay owned.
    return new Set(
      rows
        .filter((row) => row.handle !== null && !['failed', 'destroyed'].includes(row.status))
        .map((row) => row.id),
    );
  }

  private async reconcileDocker(known: Set<string>): Promise<number> {
    let removed = 0;
    let containers;
    const mine = platformInstanceId();
    try {
      // ⚠️ **按实例过滤,不是按"平台托管"过滤**。旧写法只筛 `platform.managed=true`,
      // 于是任何一个平台进程都会把**别的实例**的容器当孤儿删掉——开发机上
      // e2e(自带临时库)一跑就清空开发者正开着的 demo。理由与取舍见 instance-id.ts。
      containers = await this.docker.listContainers({
        all: true,
        filters: { label: ['platform.managed=true', `${INSTANCE_LABEL}=${mine}`] },
      });
    } catch (e) {
      this.logger.warn(`docker reconcile skipped (daemon unreachable): ${(e as Error).message}`);
      return 0;
    }
    for (const c of containers) {
      const sandboxId = c.Labels?.['platform.sandboxId'];
      if (!sandboxId) continue;
      // 双保险:即使 daemon 侧过滤失效(旧 docker/自定义 daemon),这里也不碰别人的。
      // **没有这一位的容器一律不动**——它们是本改动之前建的,宁可漏收不可误删。
      if (c.Labels?.[INSTANCE_LABEL] !== mine) continue;
      if (isPlatformOwnedSandboxId(sandboxId)) {
        // 只收已经退出 / 死掉的旧 helper；running / created / restarting / paused 一律不动
        // —— 除非它属于已经不是默认的 provider（见类注释）。
        const retired = this.retiredProvider(c.Labels?.['platform.provider']);
        if (!retired && !['exited', 'dead'].includes(c.State)) continue;
        const name = c.Names?.[0] ?? c.Id;
        try {
          await this.docker.getContainer(c.Id).remove({ force: true });
          removed++;
          this.logger.log(
            `removed stale platform auth helper container ${name} (${c.State}${retired ? ', provider is no longer the default' : ''}) left by a previous API process; HelperContainerSession recreates it`,
          );
        } catch (e) {
          this.noteHelperRemovalFailure(name, e);
        }
        continue;
      }
      if (known.has(sandboxId)) continue;
      try {
        await this.docker.getContainer(c.Id).remove({ force: true });
        removed++;
        this.logger.warn(
          `reaped ORPHAN container ${c.Names?.[0] ?? c.Id} (sandbox ${sandboxId} has no DB record)`,
        );
      } catch (e) {
        this.logger.warn(`failed to reap container ${c.Id}: ${(e as Error).message}`);
      }
    }
    return removed;
  }

  private async reconcileBoxlite(known: Set<string>): Promise<number> {
    let removed = 0;
    let runtime;
    try {
      runtime = await getSharedBoxliteRuntime();
    } catch {
      // BoxLite SDK/binary unavailable on this host — nothing to reconcile.
      return 0;
    }
    // ⚠️ boxlite 侧没有标签机制,身份只能编进**名字**(下面的 prefix)。
    // 名字里带上实例指纹,规则与 docker 侧同构:不同实例的 micro-VM 前缀不同,
    // 彼此的 `startsWith` 都不成立 ⇒ 天然互不回收。
    const minePrefix = boxliteNamePrefix();
    const boxes = await runtime.listInfo().catch((e: unknown) => {
      this.logger.warn(`boxlite reconcile skipped: ${(e as Error).message}`);
      return [];
    });
    for (const b of boxes) {
      // 旧格式(无实例段)的 box 不匹配这个前缀 ⇒ 同样"宁可漏收不可误删"。
      if (!b.name || !b.name.startsWith(minePrefix)) continue;
      const sandboxId = b.name.slice(minePrefix.length);
      if (isPlatformOwnedSandboxId(sandboxId)) {
        // 只收已经停掉 / 失败的旧 helper（开机时上一个容器里的那个必然是 stopped：BoxLite
        // 初始化会把验不了 shim 的 box 标成 Stopped）。running / configured / stopping /
        // paused / unknown 一律不动 —— 宁可留给 helper 自己按名字清，也不误删新 helper。
        // 例外同 docker 侧：boxlite 已经不是默认 provider ⇒ 不论状态都删。
        const status = (b.state?.status ?? '').toLowerCase();
        const retired = this.retiredProvider('boxlite');
        if (!retired && (b.state?.running === true || !['stopped', 'failed'].includes(status))) {
          continue;
        }
        try {
          await runtime.remove(b.id, true);
          removed++;
          this.logger.log(
            `removed stale platform auth helper ${b.name} (${status}${retired ? ', provider is no longer the default' : ''}) left by a previous API process; HelperContainerSession recreates it`,
          );
        } catch (e) {
          this.noteHelperRemovalFailure(b.name, e);
        }
        continue;
      }
      if (known.has(sandboxId)) continue;
      try {
        await runtime.remove(b.id, true);
        removed++;
        this.logger.warn(
          `reaped ORPHAN boxlite micro-VM ${b.name} (sandbox ${sandboxId} has no DB record)`,
        );
      } catch (e) {
        this.logger.warn(`failed to reap box ${b.name}: ${(e as Error).message}`);
      }
    }
    return removed;
  }

  /** helper 所属的 provider 已经不是默认 provider 了吗？认不出来 ⇒ 当作不是（照常只收死掉的）。 */
  private retiredProvider(provider: string | undefined): boolean {
    const current = this.providers?.defaultProvider;
    return current !== undefined && provider !== undefined && provider !== current;
  }

  /**
   * 删旧 helper 失败。⚠️ 「已经不在」不是失败：`HelperContainerSession` 的「先按名字清残留」可能
   * 抢先删掉了同一个实例（两道清理并发时），按快照再删一次必然撞 not found —— 记成 warn 只会
   * 误导排障。
   */
  private noteHelperRemovalFailure(name: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    if (/not found|no such/i.test(message)) {
      this.logger.debug(`stale platform auth helper ${name} was already removed: ${message}`);
      return;
    }
    this.logger.warn(`failed to remove stale platform auth helper ${name}: ${message}`);
  }
}
