import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createConnection,
  hardenDatabaseFiles,
} from '../../src/platform/persistence/drizzle.connection';

/**
 * ⭐ `platform.db` 的权限位 —— **文档一直写着「必须 0600」，而实现从来没做**
 * （shared/11 §1.2；2026-08-30 全新 `DATA_ROOT` 实测：库与两个 WAL 边车都是 0644）。
 *
 * ⚠️ 这条断言存在的理由是它**曾经是红的**：本文件在修实现之前跑，三条全红
 * （`expected 420 to be 384`）。「必须」写在文档里而没有任何东西守着，就只是一句愿望。
 *
 * ⚠️ 放在 integration 而不是 unit：它测的是 better-sqlite3 真的建出文件之后的**磁盘
 * 状态**，替身证明不了任何东西（这个缺陷恰恰是「代码看起来对、文件权限不对」）。
 */
describe('platform.db 的权限位（shared/11 §1.2 的那条「必须 0600」）', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'platform-db-perm-'));
    file = join(dir, 'platform.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const mode = (p: string): number => statSync(p).mode & 0o777;

  it('⭐ 新建的库是 0600，不是 umask 给的 0644', () => {
    // MUTATION: 去掉 `createConnection` 里第一次 `hardenDatabaseFiles` ⇒ 本条红。
    const { sqlite } = createConnection(file);
    try {
      expect(mode(file), 'platform.db 不是 0600').toBe(0o600);
    } finally {
      sqlite.close();
    }
  });

  it('⭐ `-wal` / `-shm` 一起收紧 —— 它们装的是**同一批**尚未 checkpoint 的数据', () => {
    // ⚠️ 只锁主库等于没锁：WAL 里是还没落进主库的真实行。
    // MUTATION: 把 `hardenDatabaseFiles` 里的循环缩成只处理主库 ⇒ 本条红。
    const { sqlite, db: _db } = createConnection(file);
    try {
      // 写一笔，确保 WAL 边车真的被创建出来（空库开 WAL 也会建，这里只是不指望它）。
      sqlite.exec('CREATE TABLE t (a INTEGER)');
      sqlite.exec('INSERT INTO t (a) VALUES (1)');
      for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
        expect(existsSync(sidecar), `${sidecar} 没被建出来，这条断言就没在测东西`).toBe(true);
        expect(mode(sidecar), `${sidecar} 不是 0600`).toBe(0o600);
      }
    } finally {
      sqlite.close();
    }
  });

  it('⭐ 本次改动之前留下的 0644 老库，在下一次打开时被补上', () => {
    // ⚠️ 这一条是「升级路径」：已经跑过的部署里躺着的就是 0644 的库，只修新建路径
    // 等于对存量部署什么也没做。
    // MUTATION: 把 `hardenDatabaseFiles` 改成「文件不存在才建/收紧」⇒ 本条红。
    writeFileSync(file, '');
    chmodSync(file, 0o644);
    expect(mode(file)).toBe(0o644); // 前置：确实是松的，否则下面的断言不证明任何事
    hardenDatabaseFiles(file);
    expect(mode(file)).toBe(0o600);
  });

  it(':memory: 不碰文件系统（测试用的那条路一字不变）', () => {
    expect(() => hardenDatabaseFiles(':memory:')).not.toThrow();
  });
});
