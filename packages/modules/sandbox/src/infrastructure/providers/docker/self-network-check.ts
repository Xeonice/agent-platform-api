/**
 * 「**我自己真的在这个 docker 网络里吗**」—— `SANDBOX_DOCKER_NETWORK` 那句声明里
 * 唯一填得错、而 2026-08-30 之前**一个字都没被检查**的那一半（shared/11 §1.4）。
 *
 * ══ 它修的是什么 ═══════════════════════════════════════════════════════════════
 *
 * `SANDBOX_DOCKER_NETWORK` 是一句声明：「沙箱放到这个网络里，**而我自己也在这个网络
 * 里**」。已有的守卫（`DockerContainerRuntime.agentOrigin` 的 `not attached`）查的是
 * 前半句——而沙箱容器是平台自己 `NetworkMode` 塞进去的，**前半句填不错**。
 *
 * 实测（2026-08-30，真 Linux）：api **裸跑在宿主**、同时填了这一行 ⇒
 *
 * ```
 * 沙箱容器：running / healthy，已接入 platform-sandbox-net，Ports = {}
 * agentOrigin：http://platform-aio-<id>:8080     ← 名字本身是对的
 * 而宿主解析不了这个名字（docker 内嵌 DNS 只在网络内部）
 * ⇒ sandbox 卡在 starting 超过 6 分钟，无错误、无超时、无一行日志
 * ```
 *
 * ⚠️ 也就是说，**这个配错产生的正是 §1.4 声称已经消灭的那个失败形状**，而且比原始
 * bug 更难查：原始 bug 至少还给一句 `did not become ready`，这个连那句都没有。
 *
 * ══ 怎么验才可靠：两侧各自的事实取交集，不猜 ═══════════════════════════════════
 *
 * ⛔ **不看 `/.dockerenv`、不看 cgroup、不 ping 网关。** 那些回答的是「我像不像在容器
 * 里」，而这里要回答的是「**我在不在这一个具体的网络里**」——`agent-addressing.ts` 顶部
 * 那段论证已经把「像不像在容器里」这条路否掉了（反例：`network_mode: host` 的容器）。
 *
 * ⇒ 取两个**都是事实、都不需要解释**的东西，做交集：
 *
 * | 侧 | 事实 | 来源 |
 * |---|---|---|
 * | daemon 侧 | 「这个网络上有这些容器，它们的地址是这些」 | `GET /containers/json?filters={"network":[…]}` |
 * | 进程侧 | 「我这个 netns 里持有这些地址」 | `os.networkInterfaces()` |
 *
 * **交集非空 ⇒ 我就是那个容器**：daemon 把这个地址派给了那个网络上的某个容器，而这个
 * 地址此刻在我的 netns 里 —— 除非我就是它，否则不可能同时成立（同一网络内地址唯一）。
 *
 * ⚠️ **为什么用 `/containers/json` 而不是 `/networks/<id>`**：后者更直白，但生产形态下
 * api 走的是 `docker-socket-proxy`，白名单只开了 `CONTAINERS/EXEC/IMAGES`——`NETWORKS`
 * 没开，而为了一次自检去开它（`POST=1` 之下会连带放开建/删网络）是拿隔离换便利。
 * 容器列表这条路**在今天的白名单里就能走通**。
 *
 * ⚠️ **client 侧再筛一遍 `Networks[network]`**，不完全依赖 daemon 侧的 filter：万一某个
 * 代理把 query string 吃掉，返回的是全量列表——那时按名字自己筛一遍，结论仍然正确
 * （否则「filter 被吃掉」会把一个真的接在网络上的部署判成没接，那是一次**假阴性**，
 * 而假阴性在这里等于开机拒绝启动）。
 *
 * ══ 假阴性怎么处理：宁可说「我没能验证」，也不静默放行 ═══════════════════════════
 *
 * 结论只有三种，**没有第四种「大概没事」**：
 *
 * | 结论 | 处置 |
 * |---|---|
 * | `attached` | 打一条说清证据的 log，照常启动 |
 * | `not-attached` | **开机响亮失败**（不是等第一个 Task 静静挂住） |
 * | `unverifiable` | 照常启动，但**用 error 级别说清「这一条我没能验证」**——静默放行 = 把一个已知会静静挂住的配置放过去 |
 */

/** daemon 眼里的一个网络成员：某个容器 + 它在这个网络上的地址。 */
export interface NetworkMember {
  readonly containerId: string;
  readonly name: string;
  readonly addresses: readonly string[];
}

export type SelfAttachment =
  | {
      readonly kind: 'attached';
      readonly containerId: string;
      readonly name: string;
      readonly address: string;
    }
  | { readonly kind: 'not-attached'; readonly members: readonly NetworkMember[] }
  | { readonly kind: 'unverifiable'; readonly reason: string };

/** dockerode `listContainers()` 里本检查用到的那几个字段（只声明用到的，不做双重断言）。 */
export interface ListedContainer {
  readonly Id?: string;
  readonly Names?: readonly string[];
  readonly NetworkSettings?: {
    readonly Networks?: Record<
      string,
      { readonly IPAddress?: string; readonly GlobalIPv6Address?: string } | undefined
    >;
  };
}

/** `os.networkInterfaces()` 的形状里本检查用到的那两个字段。 */
export interface LocalInterfaceAddress {
  readonly address: string;
  readonly internal: boolean;
}

/**
 * 地址归一 —— 两侧的写法并不一致，比对前必须先对齐。
 *
 * ⚠️ 三样都要削掉，少一样就会把「同一个地址」判成两个：
 *   · `/16` 前缀长度（`/networks/<id>` 那条路给的是 CIDR；容器列表给的是裸地址）
 *   · `%eth0` IPv6 zone id（Node 在 link-local 地址上会带）
 *   · 大小写（IPv6 十六进制两边可能不同）
 */
export function normalizeAddress(raw: string): string {
  const [withoutZone = ''] = raw.split('%');
  const [withoutPrefix = ''] = withoutZone.split('/');
  return withoutPrefix.trim().toLowerCase();
}

/**
 * 本进程持有的地址 —— **回环不算**。
 *
 * ⚠️ 回环必须排除，而且理由不是「噪声」：`127.0.0.1` 在每一个 netns 里都存在，把它留下
 * 等于给比对留一个恒真的机会。docker 网络的容器地址永远不是回环，所以排除它不会漏判。
 */
export function localNetworkAddresses(
  interfaces: Readonly<Record<string, readonly LocalInterfaceAddress[] | undefined>>,
): readonly string[] {
  const seen = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const address = normalizeAddress(entry.address);
      if (address !== '') seen.add(address);
    }
  }
  return [...seen];
}

/**
 * daemon 的回答 → 这个网络上的成员表。
 *
 * ⚠️ **按 `Networks[network]` 自己再筛一遍**（见文件头那条 ⚠️）：daemon 侧的 filter 被
 * 中间层吃掉时，全量列表照样能得出正确结论；反过来，若只信 filter，一次被吃掉的 query
 * 就变成一次假阴性 ⇒ 开机拒绝启动。
 */
export function membersOnNetwork(
  listed: readonly ListedContainer[],
  network: string,
): readonly NetworkMember[] {
  const members: NetworkMember[] = [];
  for (const c of listed) {
    const endpoint = c.NetworkSettings?.Networks?.[network];
    if (endpoint === undefined) continue;
    const addresses = [endpoint.IPAddress, endpoint.GlobalIPv6Address]
      .map((a) => normalizeAddress(a ?? ''))
      .filter((a) => a !== '');
    members.push({
      containerId: c.Id ?? '(unknown)',
      name: (c.Names?.[0] ?? '(unnamed)').replace(/^\//, ''),
      addresses,
    });
  }
  return members;
}

/**
 * 交集判定 —— 本文件的整个论证浓缩成的一行。
 *
 * ⚠️ **成员表为空 ≠ 无从判断**：如果本进程真的接在这个网络上，它**必然**出现在这份
 * 名单里（它自己就是一个跑着的、接在这个网络上的容器）。所以「一个成员都没有」是一条
 * 确凿的**否定**证据，不是「没数据」——这正是「网络名被 compose 加了项目名前缀」那个
 * 经典配错的形状：名字对不上 ⇒ 名单为空 ⇒ 判定 not-attached，与实情一致。
 */
export function matchSelfAmongMembers(
  members: readonly NetworkMember[],
  localAddresses: readonly string[],
): SelfAttachment {
  const mine = new Set(localAddresses);
  for (const member of members) {
    const hit = member.addresses.find((a) => mine.has(a));
    if (hit !== undefined) {
      return {
        kind: 'attached',
        containerId: member.containerId,
        name: member.name,
        address: hit,
      };
    }
  }
  return { kind: 'not-attached', members };
}

export type SelfCheckLevel = 'ok' | 'fatal' | 'unverified';

export interface SelfCheckOutcome {
  readonly level: SelfCheckLevel;
  readonly message: string;
}

/**
 * 结论 → 一条**说得出证据和下一步**的话。
 *
 * ⚠️ 这里刻意把「证据」（daemon 说了什么、我持有什么）写进消息体：`not-attached` 会让
 * 平台开不了机，而一条开不了机的错误如果只说「配错了」，运维方唯一能做的就是把这行
 * 删掉试试——那可能恰好是对的，也可能恰好是错的。
 */
export function describeSelfAttachment(
  network: string,
  attachment: SelfAttachment,
  localAddresses: readonly string[],
): SelfCheckOutcome {
  const mine = localAddresses.length === 0 ? '(none)' : localAddresses.join(', ');
  if (attachment.kind === 'attached') {
    return {
      level: 'ok',
      message:
        `本进程确认在 docker 网络 '${network}' 里：我持有 ${attachment.address}，` +
        `而 daemon 把这个地址派给了该网络上的容器 ${attachment.name} ` +
        `(${attachment.containerId.slice(0, 12)}) —— agentOrigin 会用容器名说话（shared/11 §1.4）。`,
    };
  }
  if (attachment.kind === 'unverifiable') {
    return {
      level: 'unverified',
      message:
        `⚠️ 配了 SANDBOX_DOCKER_NETWORK='${network}'，但**我没能验证「本进程真的在这个网络里」**：` +
        `${attachment.reason}。平台照常启动，可是这句配置的后半句今天没有被任何东西证实过 —— ` +
        '如果它是假的，症状是每一个沙箱都**静静地卡在 starting**（无错误、无超时、无日志，' +
        '实测 6 分钟以上）。请手动确认 api 进程与沙箱容器接在同一个用户自定义网络上（shared/11 §1.4）。',
    };
  }
  const roster =
    attachment.members.length === 0
      ? `daemon 报告 '${network}' 上**一个容器都没有** —— 若本进程真在这个网络里，它必然会出现在这份名单里（常见原因：compose 默认给网络加了项目名前缀，而这里写的必须是 docker 侧的真名）`
      : `daemon 报告 '${network}' 上有 ${String(attachment.members.length)} 个容器：` +
        attachment.members
          .map((m) => `${m.name}[${m.addresses.join('|') || 'no-address'}]`)
          .join(', ');
  return {
    level: 'fatal',
    message:
      `SANDBOX_DOCKER_NETWORK='${network}' 配了，但**本进程并不在这个 docker 网络里**，` +
      '于是平台会把沙箱地址说成 `http://platform-aio-<id>:8080` —— 那个名字只有网络内部的 ' +
      'docker 内嵌 DNS 解析得开，本进程解析不开，每一个沙箱都会静静地卡在 starting' +
      '（无错误、无超时、无日志；2026-08-30 实测 6 分钟以上）。所以这里**开机就失败**。\n' +
      `  证据：${roster}；而本进程持有的地址是 ${mine}，两者没有交集。\n` +
      '  下一步（二选一，取决于 api 到底跑在哪）：\n' +
      '  · api **裸跑在宿主** ⇒ 删掉 SANDBOX_DOCKER_NETWORK 这一行（留空 = 端口发布到宿主 ' +
      'loopback，那才是裸跑档正确的坐标）；\n' +
      '  · api **跑在容器里** ⇒ 把 api 服务也接到这个网络上（compose：服务的 `networks:` ' +
      '里带上它，且 `networks.<x>.name:` 必须与这里写的字符串一字不差），见 shared/11 §1.4。',
  };
}
