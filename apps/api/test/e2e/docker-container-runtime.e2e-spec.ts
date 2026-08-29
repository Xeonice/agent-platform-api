import { afterAll, describe, it, expect } from 'vitest';
import {
  createDockerClient,
  isDockerAvailable,
} from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-client';
import { DockerContainerRuntime } from '../../../../packages/modules/sandbox/src/infrastructure/providers/docker/docker-container-runtime';

/**
 * DOCKER-REQUIRED e2e —— **控制面**，仅此而已（docs/backend S1 acceptance）。
 *
 * ══ 这个文件测的东西变了，说清楚变在哪 ═════════════════════════════════════════
 *
 * 它以前叫 `docker-backend.e2e-spec.ts`，跑的是 `DockerContainerBackend`：
 * 建一个 **alpine** 容器（靠 `keepAliveCmd: ['tail','-f','/dev/null']` 吊着）→
 * **`docker exec ls /`** → 断言输出里有 `usr|etc` → 销毁。
 *
 * ⚠️ **那条 `docker exec` 数据面已经被删掉了**（不是搬走了）。它当时的用途是「给没有
 * agent 的裸镜像兜底」，而平台注册的方案只有 aio（自带 agent）与 boxlite（native
 * exec），没有任何一条路会走到它；留着它就是留着一条**从外面撬进沙箱**的通道，绕开
 * `hard_timeout`、绕开 job 存活语义、绕开沙箱内那道鉴权门。
 *
 * ⇒ 断言的语义因此变了，如实记在这里：
 *   · 删掉：`spawn` → `docker exec ls /` → 输出含 `usr|etc`（这条能力已不存在）
 *   · 保留：create → start → inspect(running) → destroy → inspect(missing) 这条生命周期
 *   · 新增：agent 端口**只**发布到 127.0.0.1（以前 `PortBindings` 从没被 e2e 断言过）
 *
 * 「起了容器之后能不能在里面跑东西」现在由 `aio-exec-capabilities.e2e` 与
 * `aio-agent-auth.e2e` 覆盖——它们打的是沙箱自己的 HTTP/WS API，也就是真实路径。
 *
 * ⚠️ 镜像换成 AIO：控制面的契约（尤其是「不覆盖 entrypoint」「端口发布出来」）只有
 * 在**真正带 agent 的那张镜像**上才有意义——alpine 没有 entrypoint 可覆盖、没有端口
 * 可发布，绿了也说明不了什么。镜像不在（~13GB，从不自动拉）就**大声跳过**。
 */
const IMAGE = process.env.SANDBOX_TEST_IMAGE ?? 'ghcr.io/agent-infra/sandbox:latest';
const docker = createDockerClient();
const dockerUp = await isDockerAvailable(docker).catch(() => false);
const imagePresent = dockerUp
  ? await docker
      .getImage(IMAGE)
      .inspect()
      .then(() => true)
      .catch(() => false)
  : false;
const runnable = dockerUp && imagePresent;

if (!runnable) {
  console.warn(
    '\n\x1b[33m========================================================================\n' +
      '[docker-container-runtime.e2e] SKIPPED — docker down or AIO image absent.\n' +
      `  docker daemon reachable: ${dockerUp}  (DOCKER_HOST=${process.env.DOCKER_HOST ?? 'default socket'})\n` +
      `  image ${IMAGE} present:   ${imagePresent}\n` +
      'This is the only proof that the CONTROL PLANE really drives a daemon.\n' +
      '========================================================================\x1b[0m\n',
  );
}

describe.skipIf(!runnable)('DockerContainerRuntime — 控制面 (real docker)', () => {
  const runtime = new DockerContainerRuntime(docker);
  let id: string | undefined;

  afterAll(async () => {
    if (id) await runtime.destroy(id).catch(() => undefined);
  });

  it('create → start → inspect → agentOrigin → destroy', async () => {
    id = await runtime.create({
      sandboxId: `e2e-${process.pid}`,
      instanceName: `platform-aio-e2e-${process.pid}`,
      quota: { cores: 2, ramMb: 2048, diskMb: 4096 },
      image: { ref: IMAGE, digest: 'sha256:e2e' },
      env: {},
      labels: { 'platform.test': 'true' },
      volumes: [],
      agentPort: 8080,
    });
    expect(id).toMatch(/^[0-9a-f]{12,}$/);

    // ⚠️ 未启动的容器是 `instance_creating`，不是 `instance_missing`。两者的区别是
    // 「还没起来」与「没有这个东西」——对账逻辑照着后者会**删掉正在创建的实例**。
    expect((await runtime.inspect(id)).lifecycleState).toBe('instance_creating');

    await runtime.start(id);
    expect((await runtime.inspect(id)).lifecycleState).toBe('instance_running');
    // 幂等（04 §2.2）：再 start 一次不许抛。
    await runtime.start(id);

    // ⚠️ **127.0.0.1，不是 0.0.0.0。** 沙箱内那个端口就是一个 shell 的入口；发布到
    // 通配地址等于把它挂到网上。这一条以前没有任何 e2e 断言过。
    const origin = await runtime.agentOrigin(id, 8080);
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const info = await docker.getContainer(id).inspect();
    expect(info.NetworkSettings?.Ports?.['8080/tcp']?.[0]?.HostIp).toBe('127.0.0.1');
    // ⚠️ 镜像自带的 entrypoint 必须原样保留——它才是拉起 `:8080` agent 的那个东西。
    // 覆盖掉它（旧实现的 `keepAliveCmd` 就会），容器会「running」并且**永远打不通**。
    // `info.Path` 是 daemon 真正 exec 的那个可执行文件，也就是这条断言唯一的证据。
    expect(info.Path).toContain('/opt/gem/');

    await runtime.destroy(id);
    expect((await runtime.inspect(id)).lifecycleState).toBe('instance_missing');
    // 幂等：删两次不抛（04 §2.2）。
    await runtime.destroy(id);
    id = undefined;
  }, 300_000);

  it('inspect distinguishes 「确认不存在」 from 「够不着」', async () => {
    // 一个格式合法但不存在的 id ⇒ `instance_missing`，而不是抛错。反过来，daemon
    // 够不着时必须抛 `PROVIDER_UNAVAILABLE`——两者混同会让对账把「连不上 docker」
    // 当成「实例都没了」，然后把库里的记录全清掉（04 §2.2）。
    expect((await runtime.inspect('0'.repeat(64))).lifecycleState).toBe('instance_missing');
  });
});
