/**
 * 平台自带镜像的坐标 —— **全仓唯一来源**，也是**血统的锚点**（04 §7 ★血统 ③）。
 *
 * ⚠️ **aio 与 boxlite 共用同一张**：两者都把 `pinnedImageRef(ctx.image)` 交给各自的运行时
 * （一个起容器、一个起微 VM），boxlite 只是额外走 `localhost:5001` 本地镜像站中转
 * （它的 image store 没有断点续传）。那是**拉取路径**的差别，不是镜像身份的差别，
 * 所以这里只有一个坐标。
 *
 * ── 它修的是什么 ─────────────────────────────────────────────────────────────
 * 同一个 `SANDBOX_DEFAULT_IMAGE` 曾被三处各自读取，兜底值却是**两个不同的值**：
 *   `image-seeder.ts`              → `ghcr.io/agent-infra/sandbox:latest`
 *   `image-facade.adapter.ts`      → `alpine:3.20`
 *   `provision-sandbox.workflow.ts`→ `alpine:3.20`
 * 于是没配这个 env 时，开机日志说「把 SANDBOX_DEFAULT_IMAGE 指向平台预制镜像」，
 * 而向导对用户说「镜像 `alpine:3.20` 尚未注册，请先在镜像管理里注册它」——
 * **两条提示指向两个不同的下一步，其中一条是错的**，而错的那条正好是用户看得见的那条：
 * 他会去注册一张 alpine，而那张镜像既没有 agent 也没有 tmux，注册完照样用不了。
 *
 * ⚠️ 「说错下一步比不说更贵」：它把人送去做一件必然失败的事，还让他以为是自己做错了。
 *
 * ── 兜底为什么是上游镜像（一张**过不了**根镜像检查的镜像）────────────────────
 * 这是刻意的，与 `ImageSeeder` 的注释同源：`ghcr.io/agent-infra/sandbox` 是第三方镜像，
 * 不会打我们发明的 `platform.tmux`，所以没配 env 时播种会**响亮失败**并打出一条
 * 说得出下一步的日志。**兜底值的作用是让「没配」这件事被看见，不是让它悄悄能跑。**
 * `alpine:3.20` 两样都不占：它既没让「没配」被看见（它看起来像个正经镜像名），
 * 又把用户指向了错误的方向。
 */
export function builtinImageRef(): string {
  return process.env.SANDBOX_DEFAULT_IMAGE ?? 'ghcr.io/agent-infra/sandbox:latest';
}
