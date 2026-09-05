// 断开 = detach，不是结束（06 §6.6 / §8.4）。
//
// 真踩到的一次：用户刷新页面后终端里冒出 `bash: xit: command not found`，提示符还被
// `exit` 盖掉了前四个字符。追下去发现 `handleDisconnect` 调的是 `stream.kill()`——
// 而对 PTY 来说 kill 的信号通道**就是 pty 本身**：它往终端里写 ETX + `exit\n`。
// 那两下直接落进 tmux 面板里的 shell，先 SIGINT 掉用户正在跑的 agent，再试图结束
// 它的 shell。**每关一次标签页就打断一次任务**，而 tmux 之所以是硬性镜像要求，
// 全部理由就是"会话必须活过前端断连"。
//
// 荒诞的地方：ETX 之后 bash 正在重画提示符，`exit\n` 撞进重画窗口，首字节丢了，
// shell 收到的是 `xit` ⇒ 命令没执行。**恰恰是这个丢字节救了会话**——否则 shell
// 会干净地退出，现象就变成"刷新一下任务就没了"，而不是一句莫名其妙的报错。
import { describe, it, expect } from 'vitest';
import { unusedSessions } from '../_unused-sessions';
import type { TerminalAuthenticator } from '@platform/contracts';
import type { ProcessStream } from '@platform/contracts';
import { TerminalGateway } from '../../src/interface/gateway/terminal.gateway';

interface Recording extends ProcessStream {
  writes: string[];
  kills: number;
  detaches: number;
}

/** 记录一切**写向对面**的动作；detach 之后 writes 必须还是空的。 */
function recordingStream(): Recording {
  const writes: string[] = [];
  const counts = { kills: 0, detaches: 0 };
  return {
    ref: 'fake-pty',
    writes,
    get kills(): number {
      return counts.kills;
    },
    get detaches(): number {
      return counts.detaches;
    },
    onData: (): void => {},
    onExit: (): void => {},
    write: (d: string | Buffer): void => {
      writes.push(typeof d === 'string' ? d : d.toString('utf8'));
    },
    resize: (): void => {},
    detach: (): void => {
      counts.detaches += 1;
    },
    kill: async (): Promise<void> => {
      counts.kills += 1;
      // 真实 PTY 实现的 kill 就是往终端里写字节——替身照搬这个事实，否则
      // "断开不该 kill"这条断言会因为替身太温和而失效（12 §3.4 同一课）。
      writes.push('\u0003');
      writes.push('exit\n');
    },
  };
}

function gatewayWithAttachment(stream: ProcessStream): {
  gw: TerminalGateway;
  attachments: Map<string, unknown>;
} {
  // ⛔ 原写法 `...([{}, {}, {}] as never[])` 连**参数个数都是错的**（构造只要 2 个），
  //    而 spread 一个 never[] 把这件事完全遮住了 —— 这正是「测试代码没人 typecheck」
  //    能藏住的那类东西（2026-09-05 补）。
  const gw = new TerminalGateway(
    // ⚠️ `TerminalSessionService` 是**类**（带私有字段），`as` 过不去 ——
    //    ⇒ 用 `Pick` 标注公开面，再由 `unused` 补齐类的其余部分。
    unusedSessions(),
    // ⚠️ 契约方法叫 `authorize` 且**同步返回 boolean**（不是 async authenticate）。
    { authorize: () => true } satisfies TerminalAuthenticator,
  );
  // 私有字段用 Reflect.get 取（仓规禁止 `as unknown as` 双重断言）。这里刻意不给
  // 生产代码开测试专用出口——为一条用例放宽可见性，代价比一行 Reflect.get 大。
  const attachments = Reflect.get(gw, 'attachments') as Map<string, unknown>;
  // 直接种进附着表：本用例只关心断开这一侧，不重演握手。
  attachments.set('c1', { stream, socketSessionKey: 'k', sandboxId: 'sb-1' });
  return { gw, attachments };
}

describe('TerminalGateway#handleDisconnect — 断开 = detach', () => {
  it('断开时一个字节都不往 PTY 写（tmux session 与里面的 agent 原样活着）', () => {
    const stream = recordingStream();
    const { gw } = gatewayWithAttachment(stream);

    gw.handleDisconnect({ id: 'c1' } as never);

    expect(stream.detaches).toBe(1);
    expect(stream.kills).toBe(0);
    // 判据是**写了什么**，不是"调了哪个方法"：将来有人把 detach 实现成"顺手 Ctrl+C
    // 一下再关"，方法名照样对得上，而用户的 agent 照样被打断。
    expect(stream.writes).toEqual([]);
  });

  it('断开后附着表被清掉（不泄漏）', () => {
    const { gw, attachments } = gatewayWithAttachment(recordingStream());

    gw.handleDisconnect({ id: 'c1' } as never);

    expect(attachments.has('c1')).toBe(false);
  });
});
