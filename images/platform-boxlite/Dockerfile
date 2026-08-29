# 平台预制镜像 —— **boxlite（微 VM）档**（ADR 决策 C）。
#
# ══ 为什么它必须与 aio 档**不是同一张** ═══════════════════════════════════════
#
# 决策 A 修订把**数据面**拆成了两套（aio 走沙箱内 HTTP API、boxlite 走 native
# exec/PTY），但**镜像没跟着拆**。留下的中间态谁都没得益：
#
#   > boxlite 跑着一个 13GB 的 aio 镜像，而那个镜像里的 HTTP 服务在 boxlite 档位下
#   > **一次都不会被调用**。
#
# 镜像里的 Chrome、VNC、VSCode server、Jupyter、MCP 那一整套，在微 VM 里是纯粹的死重。
# 代价是实测出来的：**冷启动 190 秒**（13GB 现拉 + 铺 rootfs），而这段时间里
# `sandbox.status` 恒为 `starting`、CPU 0%、无网络活动 —— 用户判它卡死，
# **排查的人第一眼也判它卡死**（2026-08-28 实录）。
#
# ⚠️ 而 boxlite 实际只用到 **tmux + node + CLI**。这张镜像就是那份最小集。
#
# ⚠️ **实测尺寸：1.25GB，不是 ADR 里写的「百 MB 级」。** 差在哪，如实登记：
#
#   | 层 | 大小 |
#   |---|---|
#   | `node:22-bookworm-slim` | ~590MB |
#   | apt（tmux/git/curl/ca-certs/procps） | 106MB |
#   | **两个 CLI** | **550MB**（codex 318MB + claude-code 205MB，都是预编译原生二进制） |
#
# 那 550MB 是**不可压缩**的：两个包都只装当前平台的那一份二进制（npm 按平台挑
# optionalDependency，实测 `node_modules` 里没有别的架构）。要再小只能不预装 CLI，
# 而那会把 753 秒的现装代价搬回每一个 Task。
# ⇒ 结论仍然成立（13GB → 1.25GB，**小一个数量级**，190 秒那笔账主要就是它），
#   但「百 MB 级」这个说法是错的，别照抄。
#
# ── 为什么这一项对 boxlite 特别值钱 ─────────────────────────────────────────
# aio 走 docker，本地 `docker build` 出来的镜像**直接就能用**；boxlite 的 image store
# **必须从 registry 拉**，而且**不支持断点续传**（工程注记 1：每次重试新建
# `.downloading` 临时文件，慢网下 727MB 的 Chromium 层几乎拉不全）。
# ⇒ 同样一件事，在 aio 那边是「多等一会」，在 boxlite 这边是「可能永远拉不完」。
#
# ── ⚠️ 它**不是** aio 档的镜像，别混用 ──────────────────────────────────────
# 这张镜像里**没有** `:8080` 的 agent、没有 `/v1/bash/exec`。aio 的数据面全靠那个
# HTTP 服务，拿这张去跑 aio 会在 `waitForAgent` 那步响亮超时。
FROM node:22-bookworm-slim

# tmux 是**契约要求**，不是便利：agent 会话由沙箱内的 tmux 持有，平台重启后靠
# `tmux has-session` 接回去（04 §7 ★血统 / `IMAGE_CONTRACT_VIOLATION`）。
# git / ca-certificates / curl 是 workspace clone 与 CLI 自身要用的最小集。
# procps 提供 `ps`（kill/存活判定要看它）。
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        tmux git ca-certificates curl procps; \
    rm -rf /var/lib/apt/lists/*

# ⚠️ **钉版本，不用 `@latest`** —— 与 aio 档同一条理由（04 §7「不可变坐标」）：
# `@latest` 会让**同一份源码在不同的日子产出不同的镜像**，于是再也无法从仓库回答
# 「这个 digest 里装的是哪个版本」，而上游一个坏版本会在无人改动任何东西的情况下，
# 静悄悄地进到每一个 Task 里。升级 = 改这两行 + 重新构建 + 重新推。
ARG CLAUDE_CODE_VERSION=2.1.251
ARG CODEX_VERSION=0.150.1

# ⚠️ 这里可以老老实实用默认 prefix（`/usr/local`）—— 官方 node 镜像里 root 就是运行
# 用户、`NPM_CONFIG_PREFIX` 没被改过、也没有会遮住它的旧 shim。
# aio 档那张不行，原因写在 `../platform-sandbox/Dockerfile` 与 `../README.md` 里。
RUN set -eux; \
    npm install -g \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "@openai/codex@${CODEX_VERSION}"; \
    # 构建期自证，而不是等第一个 Task 去发现。
    claude --version | grep -F "${CLAUDE_CODE_VERSION}"; \
    codex --version | grep -F "${CODEX_VERSION}"; \
    command -v tmux; \
    tmux -V; \
    npm cache clean --force

# ⚠️ **必须有一个不会立刻退出的默认命令。** 微 VM / 容器的 PID 1 一退，实例就没了，
# 而 boxlite 的数据面是 native exec —— 它需要一个**活着的**实例可以 exec 进去。
# （aio 那张不用管这件事：它自带的 entrypoint 会拉起常驻服务。）
CMD ["sleep", "infinity"]

# 与 aio 档同义：只驱动 warning 与默认配额，**不是**合规判定，且会被派生镜像继承。
LABEL platform.supportedRuntimes="codex,claude-code" \
      platform.resourceDefaults="{\"cores\":2,\"ramMb\":2048,\"diskMb\":10240}"
