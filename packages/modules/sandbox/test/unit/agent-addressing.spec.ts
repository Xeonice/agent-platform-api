import { describe, it, expect } from 'vitest';
import { SandboxProviderErrorCode } from '@platform/contracts';
import { DockerContainerRuntime } from '../../src/infrastructure/providers/docker/docker-container-runtime';
import {
  isDnsResolvableContainerName,
  resolveAgentAddressing,
  type AgentAddressing,
} from '../../src/infrastructure/providers/docker/agent-addressing';
import type { ContainerCreateSpec } from '../../src/infrastructure/providers/container-runtime.port';

/**
 * shared/11 §1.4：**loopback 发布与 DooD 是互斥的**，所以 `agentOrigin` 必须按部署形态
 * 分岔。这个文件钉的是那条分岔本身 —— 两条坐标各走各的路，且**默认那条一字未变**。
 *
 * ⚠️ 真实的可达性（DNS 解析得开、连得上）不在这里证明，它需要一个真的 docker 网络和
 * 一个真的第二方容器 ⇒ `docker-container-runtime.e2e-spec.ts`。这里证明的是**平台说
 * 出口的是哪一个坐标**，那正是 §1.4 那个事故里唯一错掉的东西：容器 healthy、端口发布
 * 正常，错的只是平台对自己说的那句 `http://127.0.0.1:<port>`。
 */
const DIGEST = `sha256:${'c'.repeat(64)}`;
const NETWORK = 'platform-sandbox-net';

interface CreateArgs {
  name?: string;
  HostConfig?: {
    NetworkMode?: string;
    PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[]>;
  };
}

function specFor(instanceName = 'platform-aio-sbx-1'): ContainerCreateSpec {
  return {
    sandboxId: 'sbx-1',
    instanceName,
    quota: { cores: 1, ramMb: 512, diskMb: 1024 },
    image: { ref: 'ghcr.io/agent-infra/sandbox:latest', digest: DIGEST },
    env: {},
    labels: {},
    volumes: [],
    agentPort: 8080,
  };
}

/** A dockerode stub that records `createContainer` and answers one canned `inspect`. */
function runtime(
  addressing: AgentAddressing,
  inspectInfo: unknown = {},
): { runtime: DockerContainerRuntime; seen: () => CreateArgs } {
  let seen: CreateArgs = {};
  const docker = {
    createContainer: (args: CreateArgs) => {
      seen = args;
      return Promise.resolve({ id: 'c1' });
    },
    getContainer: () => ({ inspect: () => Promise.resolve(inspectInfo) }),
  };
  return { runtime: new DockerContainerRuntime(docker as never, addressing), seen: () => seen };
}

describe('形态判定：显式配置 + 明确的默认值（绝不探测）', () => {
  it('没配 SANDBOX_DOCKER_NETWORK ⇒ published-port（今天的行为）', () => {
    expect(resolveAgentAddressing({})).toEqual({ mode: 'published-port' });
  });

  it('⭐ 空串算「没配」，不是「一个名叫空串的网络」', () => {
    // MUTATION: 去掉 `.trim()` 或把判断改成 `network !== undefined` ⇒ 本条红。
    // `SANDBOX_DOCKER_NETWORK=` 是 compose 里表达「我没填」最常见的写法（与
    // `isBuiltinImageConfigured` 那条 ⚠️ 同源）；当成网络名会让 create 直接失败。
    expect(resolveAgentAddressing({ SANDBOX_DOCKER_NETWORK: '' })).toEqual({
      mode: 'published-port',
    });
    expect(resolveAgentAddressing({ SANDBOX_DOCKER_NETWORK: '   ' })).toEqual({
      mode: 'published-port',
    });
  });

  it('配了网络名 ⇒ container-network，名字原样带上', () => {
    expect(resolveAgentAddressing({ SANDBOX_DOCKER_NETWORK: ` ${NETWORK} ` })).toEqual({
      mode: 'container-network',
      network: NETWORK,
    });
  });
});

describe('published-port（默认档）—— 一字未变', () => {
  it('端口发布到 127.0.0.1，且不设 NetworkMode', async () => {
    const { runtime: rt, seen } = runtime({ mode: 'published-port' });
    await rt.create(specFor());
    expect(seen().HostConfig?.PortBindings?.['8080/tcp']).toEqual([
      { HostIp: '127.0.0.1', HostPort: '' },
    ]);
    expect(seen().HostConfig?.NetworkMode).toBeUndefined();
  });

  it('agentOrigin 用发布出来的宿主端口', async () => {
    const { runtime: rt } = runtime(
      { mode: 'published-port' },
      { NetworkSettings: { Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '45995' }] } } },
    );
    expect(await rt.agentOrigin('c1', 8080)).toBe('http://127.0.0.1:45995');
  });
});

describe('container-network —— 容器名坐标，且端口一个都不发布', () => {
  it('⭐ 不发布任何端口，改为加入指定网络', async () => {
    // MUTATION: 把 `...(network !== null ? {NetworkMode} : {PortBindings})` 改回无条件
    // `PortBindings` ⇒ 本条红。这一位是选方案③ 的**理由本身**：沙箱 agent 端口可以
    // 完全不发布，暴露面比默认档还小。丢了它，方案③ 就只剩「换个地址写法」。
    const { runtime: rt, seen } = runtime({ mode: 'container-network', network: NETWORK });
    await rt.create(specFor());
    expect(seen().HostConfig?.NetworkMode).toBe(NETWORK);
    expect(seen().HostConfig?.PortBindings).toBeUndefined();
  });

  it('⭐ agentOrigin 用容器名 + 沙箱内端口，不是宿主发布端口', async () => {
    // MUTATION: 让 agentOrigin 忽略 addressing、照旧读 Ports ⇒ 本条红。
    // ⚠️ 端口用的是 **agentPort（8080）**，不是宿主侧那个 45995：容器名解析出来的是
    // 容器自己的 netns，里面 agent 就监听在 8080 上。
    const { runtime: rt } = runtime(
      { mode: 'container-network', network: NETWORK },
      {
        Name: '/platform-aio-sbx-1',
        NetworkSettings: {
          Networks: { [NETWORK]: { IPAddress: '172.20.0.3' } },
          // 即便宿主上恰好也发布了端口，容器里的 api 也不该用它 —— 那个坐标只有宿主解得开。
          Ports: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '45995' }] },
        },
      },
    );
    expect(await rt.agentOrigin('c1', 8080)).toBe('http://platform-aio-sbx-1:8080');
  });

  it('⭐ 容器不在那个网络上 ⇒ 一条指名道姓的 INVALID_STATE，而不是等超时', async () => {
    // MUTATION: 删掉 attached 检查 ⇒ 本条红。没有它，症状是一次 `did not become
    // ready` 超时，而那句话会把人送去查沙箱镜像 —— §1.4 事故里真跑偏过的方向。
    const { runtime: rt } = runtime(
      { mode: 'container-network', network: NETWORK },
      { Name: '/platform-aio-sbx-1', NetworkSettings: { Networks: { bridge: {} } } },
    );
    const thrown = await rt.agentOrigin('c1', 8080).catch((e: unknown) => e);
    expect((thrown as { code: string }).code).toBe(SandboxProviderErrorCode.INVALID_STATE);
    expect((thrown as Error).message).toContain(NETWORK);
    // 说得出「它现在在哪几个网络上」——否则运维方只知道「不对」，不知道对在哪。
    expect((thrown as Error).message).toContain('bridge');
  });

  it('⭐ 名字不是 DNS label ⇒ 在 create 门口就拒，不留一个「起得来但永远连不上」的容器', async () => {
    // MUTATION: 删掉 `isDnsResolvableContainerName` 那道门 ⇒ 本条红。
    const { runtime: rt } = runtime({ mode: 'container-network', network: NETWORK });
    const thrown = await rt.create(specFor('platform_aio_SBX_1')).catch((e: unknown) => e);
    expect((thrown as { code: string }).code).toBe(SandboxProviderErrorCode.INVALID_STATE);
  });

  it('默认档不管名字长什么样 —— 那一档根本不靠名字解析', async () => {
    const { runtime: rt } = runtime({ mode: 'published-port' });
    await expect(rt.create(specFor('platform_aio_SBX_1'))).resolves.toBe('c1');
  });
});

describe('容器名的可解析性（跨形态是否稳定）', () => {
  it('今天的形状 `platform-aio-<uuid>` 是合法 DNS label', () => {
    // 49 字符，全小写，只有连字符 —— 稳稳落在 63 的上限内。
    expect(isDnsResolvableContainerName('platform-aio-1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809')).toBe(
      true,
    );
  });

  it.each([
    ['platform_aio_x', '下划线：docker 容器名允许，DNS label 不允许'],
    ['Platform-Aio-X', '大写：部分解析路径原样比对'],
    ['-platform-aio-x', '连字符开头'],
    ['platform-aio-x-', '连字符结尾'],
    [`platform-aio-${'x'.repeat(60)}`, '超过 63 字符'],
    ['', '空名字'],
  ])('%s 判为不可解析（%s）', (name) => {
    expect(isDnsResolvableContainerName(name)).toBe(false);
  });
});
