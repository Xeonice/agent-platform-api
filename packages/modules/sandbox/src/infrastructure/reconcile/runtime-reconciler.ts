import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type Docker from 'dockerode';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DATABASE } from '@platform/shared-kernel';
import { DOCKER_CLIENT } from '../providers/docker/docker.token';
import { getSharedBoxliteRuntime } from '../providers/boxlite/boxlite-runtime';
import { sandboxes } from '../persistence/schema/sandbox.sqlite';
import { INSTANCE_LABEL, platformInstanceId } from './instance-id';

type Db = BetterSQLite3Database<Record<string, never>>;

const BOXLITE_NAME_PREFIX = 'platform-boxlite-';

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
 */
@Injectable()
export class RuntimeReconciler implements OnApplicationBootstrap {
  private readonly logger = new Logger('RuntimeReconciler');

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(DOCKER_CLIENT) private readonly docker: Docker,
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
    const rows = this.db.select({ id: sandboxes.id }).from(sandboxes).all();
    return new Set(rows.map((r) => r.id));
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
      if (!sandboxId || known.has(sandboxId)) continue;
      // 双保险:即使 daemon 侧过滤失效(旧 docker/自定义 daemon),这里也不碰别人的。
      // **没有这一位的容器一律不动**——它们是本改动之前建的,宁可漏收不可误删。
      if (c.Labels?.[INSTANCE_LABEL] !== mine) continue;
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
    const minePrefix = `${BOXLITE_NAME_PREFIX}${platformInstanceId()}-`;
    const boxes = await runtime.listInfo().catch((e: unknown) => {
      this.logger.warn(`boxlite reconcile skipped: ${(e as Error).message}`);
      return [];
    });
    for (const b of boxes) {
      // 旧格式(无实例段)的 box 不匹配这个前缀 ⇒ 同样"宁可漏收不可误删"。
      if (!b.name || !b.name.startsWith(minePrefix)) continue;
      const sandboxId = b.name.slice(minePrefix.length);
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
}
