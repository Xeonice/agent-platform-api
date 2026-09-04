import { z } from 'zod';

/**
 * 契约的**字段级**原语（shared/10 §6 / 09 §2.3）。
 *
 * ── 为什么需要这个文件 ────────────────────────────────────────────────────────
 * 契约里曾有 48% 的 DTO 字段是**裸 `z.string()`**、`format` 一个都没有。
 * 「`ProjectDto.createdAt` 是个字符串」——契约只说到这里为止。真后端发的是
 * `2026-09-04T06:56:40.066Z`、前端替身写 `new Date().toISOString()`，两边碰巧一致
 * 靠的是 `toISOString()` 的惯例，**不是契约保证的**。于是任何一个照契约写替身的人
 * 都可以合法地写出 `'2026/09/04 14:56'`，而没有任何一层会红。
 *
 * ⇒ 把「这是个 ISO 瞬时」写进契约本身，它才会进 openapi、进生成类型的旁注、
 *   进前端 zod 的 `.datetime()`。这一层是**唯一**能让这类漂移不再复发的地方。
 *
 * ── 使用纪律（⛔ 这两条不是建议）────────────────────────────────────────────
 * ① **只给出站（response）DTO 用。** 入站 DTO 走全局 `ZodValidationPipe`，
 *    在这里多一个 check 就是**真的开始拒绝**以前接受的请求 —— 那是 breaking change，
 *    不是「让文档更准」。入站字段的形状校验留在各自的值对象 / 应用层（它们能给出
 *    带领域语义的 400，而不是一句 `invalid datetime`）。
 * ② **只给平台自己 `toISOString()` 产出的字段用。** 凡是**透传第三方字符串**的
 *    时刻字段（provider 报的健康检查时刻、沙箱内 agent 报的文件 mtime）都**不许**
 *    用它 —— 契约写了 `date-time` 而实现发得出 `''`，那是把一个已知缺口伪装成保证。
 *    那种字段的现状见各自定义处的注释。
 */

/**
 * ISO-8601 **UTC 瞬时**（`Date#toISOString()` 的出线形状，末尾 `Z`）。
 * → openapi `{"type":"string","format":"date-time"}`。
 *
 * ⚠️ zod 的 `.datetime()` **默认不放行时区偏移**（`+08:00` 会被拒），这正是我们要的：
 * 平台对外只发 UTC，前端据此可以无条件 `new Date(v)` 并按本地时区渲染。
 */
export const IsoInstantSchema = z.string().datetime();

/**
 * 绝对 URL（`new URL(v)` 解析得通）。→ openapi `{"type":"string","format":"uri"}`。
 *
 * ⛔ **不要拿它去标 `repoUrl`。** git 远端合法地包含 scp 形式 `user@host:path`
 * （见 `RepoUrl` 值对象 / `parseGitRemote`），那不是合法 URI —— 标上去等于在契约里
 * 撒谎，还会诱导下一个人给入站的 `repoUrl` 加 `.url()` 把 SSH 远端整片拒掉。
 */
export const AbsoluteUrlSchema = z.string().url();
