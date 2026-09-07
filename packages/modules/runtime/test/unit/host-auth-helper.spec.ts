import { describe, it, expect, afterEach } from 'vitest';
import { isAbsolute } from 'node:path';
import { rm } from 'node:fs/promises';
import { HostAuthHelper } from '../../src/infrastructure/helper/host-auth-helper';

/**
 * 宿主形态的 auth helper —— 2026-09-07 实测修的两件事。
 *
 * ⚠️ 本文件**不跑真的登录 CLI**（那要网络与订阅）。它守的是两条纯本地的不变量，
 * 而这两条正是真机上把 claude 帐号授权整条打挂的那两条。
 */
const helper = new HostAuthHelper();
const opened: string[] = [];

afterEach(async () => {
  for (const d of opened.splice(0))
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

describe('HostAuthHelper：隔离 HOME 必须是绝对路径', () => {
  it('⭐ DATA_ROOT 是相对的时候，homeDir 仍然是绝对路径', async () => {
    // ⛔ 这条修的是一个**只打挂一半 runtime** 的 bug：`DATA_ROOT` 出厂是 `./data`
    //    （相对），于是 homeDir 也是相对的，而它会被当作 HOME / CODEX_HOME /
    //    CLAUDE_CONFIG_DIR 交给子进程。子进程的 cwd 一换，那个相对路径就指向别处 ——
    //    实测 codex 立刻退出并报
    //    `CODEX_HOME points to "data/auth-helper/h-XXXX", but that path does not exist`，
    //    而 claude 不校验这个目录、照跑不误。⇒ 看起来像「codex 坏了」，其实是路径是相对的。
    //
    // MUTATION: 把 `resolve(...)` 换回 `join(...)` ⇒ 本条红。
    const prev = process.env.DATA_ROOT;
    process.env.DATA_ROOT = './data';
    try {
      const s = await helper.openSession(['/bin/echo', 'hi']);
      opened.push(s.homeDir);
      expect(isAbsolute(s.homeDir), `homeDir 必须绝对: ${s.homeDir}`).toBe(true);
      await s.dispose();
    } finally {
      if (prev === undefined) delete process.env.DATA_ROOT;
      else process.env.DATA_ROOT = prev;
    }
  });

  it('⭐ 子进程拿到的是**真伪终端** —— 登录 CLI 会检测 TTY', async () => {
    // ⛔ 此前这里是 `child_process.spawn(..., stdio:'pipe')`。实测：
    //      claude setup-token 走管道 ⇒ **0 字节**；走 PTY ⇒ 3.4KB + OSC-8 授权链接。
    //    而解析器认的正是 OSC-8 ⇒ `readUntil` 空等满 120s ⇒ 用户看到一个哑巴 HTTP 500。
    //
    // ⚠️ 这里用 `tty` 命令自证：它在非 TTY 上打印 "not a tty"。
    // MUTATION: 换回 child_process 管道 ⇒ 本条红。
    const s = await helper.openSession(['/usr/bin/tty']);
    opened.push(s.homeDir);
    const out = await new Promise<string>((resolvePromise) => {
      let buf = '';
      s.pty.onData((c) => {
        buf += c.toString('utf8');
      });
      s.pty.onExit(() => resolvePromise(buf));
      setTimeout(() => resolvePromise(buf), 5_000);
    });
    await s.dispose();
    expect(out.toLowerCase(), `tty(1) 说这不是终端：${JSON.stringify(out)}`).not.toContain(
      'not a tty',
    );
    expect(out).toMatch(/\/dev\/(tty|pts)/);
  });
});
