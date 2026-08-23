// 附着失败时的两条路（本轮 review 后补齐）。
//
// 原始故障：`openSession` 失败时网关**一句话不说就挂断**，而"连上又断"与网络抖动
// 在客户端看来完全一样 —— 它只能按抖动重试，每次都走进同一个 catch，烧完 9 次退避
// 才停，那个「手动重连」每按一次又清零预算重来一轮。
//
// 但修的时候差点过头：能从这里抛出来的不只有永久故障，还有 `PROVIDER_UNAVAILABLE`
// 这类瞬时故障。一律发终止信号 = 把本来能自愈的抖动也判成永久故障。下面两条分别
// 钉住这两半。
import { describe, it, expect } from 'vitest';
import {
  SandboxProviderError,
  SandboxProviderErrorCode,
  TERMINAL_EXIT_ATTACH_FAILED,
} from '@platform/contracts';
import { TerminalGateway } from '../../src/interface/gateway/terminal.gateway';

interface Sent {
  frames: unknown[];
  disconnected: boolean;
}

/** 造一个 openSession 必抛 `err` 的网关，并记录它对客户端说了什么。 */
async function attachWith(err: unknown): Promise<Sent> {
  const sessions = {
    openSession: (): Promise<never> => Promise.reject(err),
  };
  const gw = new TerminalGateway(...([sessions, {}] as never[]));
  const sent: Sent = { frames: [], disconnected: false };
  const client = {
    id: 'c1',
    handshake: { query: { sandboxId: 'sb-1', cols: '80', rows: '24' } },
    emit: (_ev: string, f: unknown) => {
      sent.frames.push(f);
    },
    disconnect: () => {
      sent.disconnected = true;
    },
  };
  await gw.handleConnection(client as never);
  return sent;
}

describe('TerminalGateway 附着失败：说不说、说什么', () => {
  it('不可重试 → 发 exit(-2) 再挂断，让客户端当场停止重连', async () => {
    const sent = await attachWith(
      new SandboxProviderError(SandboxProviderErrorCode.NOT_FOUND, 'sandbox gone'),
    );

    expect(sent.frames).toEqual([{ type: 'exit', code: TERMINAL_EXIT_ATTACH_FAILED }]);
    expect(sent.disconnected).toBe(true);
    // ⚠️ 判据里 `-2` 不是随手挑的数：`-1` 已经表示"进程退出但退出码未知"（被信号
    // 杀死）。复用它会让"agent 被 OOM kill"与"沙箱整个不在了"变成字节级相同的一帧，
    // 而这两件事对用户的下一步完全不同。
    expect(TERMINAL_EXIT_ATTACH_FAILED).not.toBe(-1);
  });

  it('⚠️ 可重试 → **一帧都不发**，保住客户端退避重连的自愈能力', async () => {
    const sent = await attachWith(
      new SandboxProviderError(
        SandboxProviderErrorCode.PROVIDER_UNAVAILABLE,
        'agent not reachable yet',
        undefined,
        true, // retryable
      ),
    );

    // 这条挡住"图省事一律发终止信号"那种改法 —— 那会把瞬时抖动判成永久故障。
    expect(sent.frames).toEqual([]);
    expect(sent.disconnected).toBe(true);
  });

  it('非 provider 错误按不可重试处理（宁可给一句明确的话，也别让人盯两分钟）', async () => {
    const sent = await attachWith(new Error('tmux probe blew up'));
    expect(sent.frames).toEqual([{ type: 'exit', code: TERMINAL_EXIT_ATTACH_FAILED }]);
  });
});
