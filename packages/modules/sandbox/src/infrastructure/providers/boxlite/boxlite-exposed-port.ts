import { generateKeyPairSync } from 'node:crypto';

/**
 * ══ boxlite 的暴露面加固：与数据面**无关**，纯粹是端口的事 ══════════════════
 *
 * 决策 A 修订里写着「boxlite 不再需要转发端口 ⇒ 该攻击面在这一档直接消失」。
 * **实测把这半句推翻了。** BoxLite 会把镜像 `EXPOSE` 的端口**自动发布到宿主**，
 * 而且是**通配地址**，我们要不要都一样：
 *
 * | `JsBoxOptions.ports` | 宿主上新增的监听（`lsof`，同一次 create 前后取差集） |
 * |---|---|
 * | 不传 | `*:8080` |
 * | `[]`（空数组） | `*:8080` —— 空数组等于没传 |
 * | `[{ guestPort: 1 }]` | `*:8080` **和** `*:1` —— 给**别的** guest 端口加映射只是**追加** |
 * | `[{ hostPort: 45999, guestPort: 8080, hostIp: '127.0.0.1' }]` | `*:45999` —— 给**同一个** guest 端口加映射会**改掉它的宿主端口**；`hostIp` **被忽略**，根本不是 loopback |
 *
 * 归纳出来的规则（provider 就是按它写的）：**镜像 `EXPOSE` 的每个端口都会被发布，
 * hostPort 默认等于 guestPort；为该 guest 端口显式指定 hostPort 只能改宿主那一侧的
 * 号，不能取消发布。**
 *
 * 另有旁证：宿主 8080 被别的进程占着时，一次**没传任何 ports** 的 `create` 直接
 * 失败在 `gvproxy_create failed: cannot add network services: listen tcp
 * 0.0.0.0:8080: bind: address already in use`。⚠️ 这条不只是理论——本仓 e2e 一次跑
 * 两个 boxlite 沙箱时**真的红过**，因为两个 box 都想绑固定的 8080。
 * 所以 `create()` 仍然给 guest 8080 指一个**空闲宿主端口**：不是为了连它，
 * 而是把这个无法关闭的发布从「固定端口」挪到「唯一端口」，让多沙箱能共存。
 *
 * ⇒ 两条结论，都写进代码而不只是文档：
 *  ① **关不掉。** 这一档没有「不发布」这个选项，所以「换成 native 之后端口攻击面
 *     消失了」是错的；ADR 的那句话需要按本表更正。
 *  ② **既然关不掉，那扇门就必须上锁。** AIO 镜像自带鉴权网关，只是默认关：
 *     `/opt/gem/entrypoint.sh` 依据 `JWT_PUBLIC_KEY` 是否非空，在
 *     `nginx-server-without-auth.conf` 与 `nginx-server-with-auth.conf` 之间切换。
 *     实测（同一镜像、同一条请求，只差这一个环境变量）：
 *       不注入 ⇒ `POST http://[::1]:8080/v1/bash/exec {"command":"id"}` **HTTP 200**，
 *                返回 `uid=1000(gem)`——一个**局域网内任意机器**都能打的免鉴权 shell；
 *       注入   ⇒ 同一条请求 **HTTP 401**（`GET /v1/ping` 仍 200，那是白名单）。
 *
 * ⚠️ **这不是「boxlite 还在用沙箱内 agent」。** 我们注入的是一把**只上锁、不留钥匙**
 * 的公钥：私钥当场丢弃，token 一枚都不签、不落库、`providerState` 依旧是空的。
 * 平台连自己都进不去那扇门——因为平台根本不需要进去，数据面全在 native 那侧。
 * 所以 04 §2.2 的「删掉 boxlite 对 agent 的依赖」是成立的：删掉的是**数据面依赖**，
 * 留下的是**对同一张镜像里那个 HTTP 服务的封口**。
 *
 * ⏳ 残留风险（如实登记）：`:8080` 仍然对外可达，只是回 401。真正的收口应该是
 * 「让 BoxLite 别发布」或「给微 VM 加网络策略」，两者当前 SDK 都没给；一旦
 * `@boxlite-ai/boxlite` 提供了抑制自动发布的开关，这一整个文件都该删掉。
 */

/** AIO 镜像用来打开自带 nginx 鉴权网关的环境变量。 */
export const IMAGE_AUTH_GATEWAY_ENV = 'JWT_PUBLIC_KEY';

/**
 * 生成一把一次性 RSA-2048 公钥（base64 的 PEM SPKI），**私钥立即丢弃**。
 *
 * 镜像那侧只认 RS256（`jwt_algorithms=["RS256"]` 硬编码），拿不到对应私钥就签不出
 * 任何能过 `GET /auth` 的 token —— 也就是说这把钥匙生成完就没人有了，那扇门对
 * **所有人**（包括平台自己）永久关闭。这正是我们要的：门在那儿，只是没人能进。
 */
export function mintClosedGatewayKey(): string {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return Buffer.from(publicKey, 'utf8').toString('base64');
}

/**
 * 把公钥并进沙箱 env。
 *
 * ⚠️ **我们的值压过调用方的值**，顺序不是随手写的：调用方若能覆盖这个变量，
 * 只要把它设成空串，镜像 entrypoint 就会切回**免鉴权**那份 nginx 配置——一个
 * 「用户可配置的字段」就能把上面整段加固关掉。
 */
export function withClosedGatewayEnv(env: Record<string, string>): Record<string, string> {
  return { ...env, [IMAGE_AUTH_GATEWAY_ENV]: mintClosedGatewayKey() };
}
