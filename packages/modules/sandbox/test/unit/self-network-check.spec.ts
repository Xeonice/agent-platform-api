import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  describeSelfAttachment,
  localNetworkAddresses,
  matchSelfAmongMembers,
  membersOnNetwork,
  normalizeAddress,
  type ListedContainer,
  type NetworkMember,
} from '../../src/infrastructure/providers/docker/self-network-check';
import { DockerSelfNetworkCheck } from '../../src/infrastructure/providers/docker/self-network-check.service';

/**
 * shared/11 §1.4 的**第二半**：`SANDBOX_DOCKER_NETWORK` 那句声明里唯一填得错、而
 * 2026-08-30 之前一个字都没被检查的那一半 ——「**而我自己也在这个网络里**」。
 *
 * ⚠️ 本文件刻意把判定拆成纯函数单独测（与 `reflinkStrategy(os)`、内存探针同一手法）：
 * 「我在不在某个 docker 网络里」这件事，在开发机上**恒为否**、在 CI 里也恒为否，
 * 一条直接调真 docker 的断言只会写出「在本机永远为真」的那种测试 —— 它红不了，
 * 也就证明不了任何事。这里把两侧的事实（daemon 的成员表 / 本进程的地址表）当成入参，
 * 于是两种结论都测得到，且都能被改坏改红。
 *
 * 真实可达性（真 docker、真网络）不在这里证明 —— 那属于
 * `docker-container-runtime.e2e-spec.ts` 的 container-network 那一组。
 */
const NET = 'platform-sandbox-net';

function listed(network: string, ip: string, name = 'platform-api-1'): ListedContainer {
  return {
    Id: 'abcdef0123456789',
    Names: [`/${name}`],
    NetworkSettings: { Networks: { [network]: { IPAddress: ip } } },
  };
}

describe('地址归一 —— 两侧的写法不一致，比对前必须对齐', () => {
  it('⭐ 削掉 CIDR 前缀 / IPv6 zone / 大小写', () => {
    // MUTATION: 去掉 `.split('/')` ⇒ 第一条红；去掉 `.split('%')` ⇒ 第二条红；
    // 去掉 `.toLowerCase()` ⇒ 第三条红。三样少任何一样，同一个地址会被判成两个 ——
    // 而「判成两个」在这里等于一次假阴性 ⇒ 开机拒绝启动。
    expect(normalizeAddress('172.20.0.3/16')).toBe('172.20.0.3');
    expect(normalizeAddress('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeAddress('FE80::AB')).toBe('fe80::ab');
  });
});

describe('本进程持有哪些地址', () => {
  it('⭐ 回环不算 —— 它在每个 netns 里都存在，留着等于给比对一个恒真的机会', () => {
    // MUTATION: 去掉 `if (entry.internal) continue` ⇒ 本条红。
    expect(
      localNetworkAddresses({
        lo: [{ address: '127.0.0.1', internal: true }],
        eth0: [{ address: '172.20.0.3', internal: false }],
      }),
    ).toEqual(['172.20.0.3']);
  });

  it('多网卡去重，且 undefined 的条目不炸', () => {
    expect(
      localNetworkAddresses({
        eth0: [
          { address: '172.20.0.3', internal: false },
          { address: '172.20.0.3', internal: false },
        ],
        eth1: [{ address: 'fe80::1%eth1', internal: false }],
        gone: undefined,
      }),
    ).toEqual(['172.20.0.3', 'fe80::1']);
  });
});

describe('daemon 的回答 → 这个网络上的成员表', () => {
  it('⭐ 自己再按网络名筛一遍，不完全指望 daemon 侧的 filter', () => {
    // MUTATION: 删掉 `if (endpoint === undefined) continue` ⇒ 本条红。
    // 中间层（socket-proxy / 反代）把 query string 吃掉时返回的是**全量列表**；
    // 只信 filter 的话，一个真的接在网络上的部署会被判成没接 —— 假阴性在这里
    // 等于开机拒绝启动。
    const members = membersOnNetwork(
      [listed(NET, '172.20.0.3'), listed('bridge', '172.17.0.2', 'someone-else')],
      NET,
    );
    expect(members.map((m) => m.name)).toEqual(['platform-api-1']);
  });

  it('IPv4 与 IPv6 都收下（只有 IPv6 地址的网络照样能对上）', () => {
    const members = membersOnNetwork(
      [
        {
          Id: 'deadbeef',
          Names: ['/x'],
          NetworkSettings: { Networks: { [NET]: { GlobalIPv6Address: 'fd00::5' } } },
        },
      ],
      NET,
    );
    expect(members[0]?.addresses).toEqual(['fd00::5']);
  });
});

describe('交集判定 —— 整个论证浓缩成的一行', () => {
  it('⭐ 我持有 daemon 派给该网络某容器的地址 ⇒ 我就是那个容器', () => {
    // MUTATION: 把 `mine.has(a)` 改成恒 true / 恒 false ⇒ 本条或下一条红。
    const verdict = matchSelfAmongMembers(membersOnNetwork([listed(NET, '172.20.0.3')], NET), [
      '172.20.0.3',
    ]);
    expect(verdict.kind).toBe('attached');
    expect(verdict.kind === 'attached' && verdict.name).toBe('platform-api-1');
  });

  it('⭐ 网络上有别人、没有我 ⇒ not-attached（这就是 api 裸跑却填了这一行的形状）', () => {
    const verdict = matchSelfAmongMembers(
      membersOnNetwork([listed(NET, '172.20.0.3', 'platform-aio-sbx-1')], NET),
      ['192.168.1.7'], // 宿主自己的网卡地址，与那个网络毫无关系
    );
    expect(verdict.kind).toBe('not-attached');
  });

  it('⭐ 成员表为空是**确凿的否定**，不是「没数据」', () => {
    // ⚠️ 若本进程真接在这个网络上，它必然出现在这份名单里（它自己就是一个跑着的、
    // 接在这个网络上的容器）。所以空名单 = 我不在 —— 这正是「compose 给网络加了项目名
    // 前缀」那个经典配错的形状：名字对不上 ⇒ 名单为空。
    // MUTATION: 把空名单改判成 unverifiable ⇒ 本条红，而那个改动会让最常见的一种
    // 配错（前缀）重新变回静默死机。
    expect(matchSelfAmongMembers([], ['172.20.0.3']).kind).toBe('not-attached');
  });
});

describe('结论 → 一条说得出证据和下一步的话', () => {
  const members: NetworkMember[] = [
    { containerId: 'c1', name: 'platform-aio-sbx-1', addresses: ['172.20.0.3'] },
  ];

  it('⭐ not-attached 的消息必须同时给出**两条**出路，按 api 跑在哪分岔', () => {
    // MUTATION: 只保留其中一条出路 ⇒ 本条红。⚠️ 这条开不了机的错误如果只说「配错了」，
    // 运维方唯一能做的就是把这行删掉试试 —— 而那对 compose 形态恰好是错的（删掉之后
    // 回到 §1.4 开头那个 `did not become ready`）。
    const { level, message } = describeSelfAttachment(NET, { kind: 'not-attached', members }, [
      '192.168.1.7',
    ]);
    expect(level).toBe('fatal');
    expect(message).toContain('裸跑在宿主');
    expect(message).toContain('跑在容器里');
    // 证据两侧都要在场，否则运维方只知道「不对」，不知道对在哪。
    expect(message).toContain('172.20.0.3');
    expect(message).toContain('192.168.1.7');
  });

  it('⭐ 空名单时点名「项目名前缀」这个最常见的原因', () => {
    const { message } = describeSelfAttachment(NET, { kind: 'not-attached', members: [] }, [
      '10.0.0.2',
    ]);
    expect(message).toContain('项目名前缀');
  });

  it('⭐ 验不了 ⇒ 不是 fatal，但也**不是静默放行**', () => {
    // MUTATION: 把 unverifiable 归到 'ok' ⇒ 本条红。「大概没事」是这里唯一不许有的结论。
    const { level, message } = describeSelfAttachment(
      NET,
      { kind: 'unverifiable', reason: '问不到 docker（connect ECONNREFUSED）' },
      ['172.20.0.3'],
    );
    expect(level).toBe('unverified');
    expect(message).toContain('没能验证');
    expect(message).toContain('connect ECONNREFUSED');
  });

  it('attached 的消息说清证据（我持有哪个地址、它属于谁）', () => {
    const { level, message } = describeSelfAttachment(
      NET,
      {
        kind: 'attached',
        containerId: 'abcdef0123456789',
        name: 'platform-api-1',
        address: '172.20.0.3',
      },
      ['172.20.0.3'],
    );
    expect(level).toBe('ok');
    expect(message).toContain('abcdef012345');
    expect(message).toContain('platform-api-1');
  });
});

describe('开机钩子：没配就什么都不做，配错了就开不了机', () => {
  const withEnv = async (network: string | undefined, docker: unknown): Promise<unknown> => {
    const saved = process.env.SANDBOX_DOCKER_NETWORK;
    if (network === undefined) delete process.env.SANDBOX_DOCKER_NETWORK;
    else process.env.SANDBOX_DOCKER_NETWORK = network;
    try {
      const check = new DockerSelfNetworkCheck(docker as never);
      return await check.onApplicationBootstrap().catch((e: unknown) => e);
    } finally {
      if (saved === undefined) delete process.env.SANDBOX_DOCKER_NETWORK;
      else process.env.SANDBOX_DOCKER_NETWORK = saved;
    }
  };

  it('⭐ 没配 SANDBOX_DOCKER_NETWORK ⇒ 一次 docker 都不问（裸跑档一字未变）', async () => {
    // MUTATION: 去掉 `if (addressing.mode !== 'container-network') return` ⇒ 本条红。
    // 裸跑档是绝大多数部署与全部 e2e 走的那一档，多问一次 docker 就是给它们加一个
    // 可能失败的启动依赖。
    const listContainers = vi.fn();
    expect(await withEnv(undefined, { listContainers })).toBeUndefined();
    expect(listContainers).not.toHaveBeenCalled();
  });

  it('⭐ 配了、而本进程不在 ⇒ **抛**，开机就失败（不是等到第一个 Task）', async () => {
    // MUTATION: 把 fatal 那支改成 `this.logger.error(...)` 而不 throw ⇒ 本条红。
    // 「等第一个 Task」正是这个缺陷本身：那时候它不报错，它**静静地卡住**。
    // ⚠️ 用 RFC 5737 的 TEST-NET-1（192.0.2.0/24）当沙箱地址：它保证不会是**跑测试的
    // 那台机器**自己持有的地址，否则这条断言会在某些 CI 形态下偶然变绿。
    const listContainers = vi.fn(async () =>
      Promise.resolve([listed(NET, '192.0.2.10', 'platform-aio-sbx-1')]),
    );
    const thrown = await withEnv(NET, { listContainers });
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(NET);
  });

  it('⭐ docker 问不到 ⇒ 不阻断启动，但打 error 级别的「我没能验证这一条」', async () => {
    // MUTATION: 把这一支改成 `logger.warn` 或直接不打 ⇒ 本条红。
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const listContainers = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));
    try {
      expect(await withEnv(NET, { listContainers })).toBeUndefined();
      expect(String(error.mock.calls[0]?.[0] ?? '')).toContain('没能验证');
    } finally {
      error.mockRestore();
    }
  });
});
