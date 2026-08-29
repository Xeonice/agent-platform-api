# 平台预制**默认**镜像 —— 也是血统的锚点（04 §7 ★血统）。
#
# ══ 2026-08：中间那层 `platform/base` 被删掉了 ═══════════════════════════════════
#
# 这里曾经是三层：`上游 → platform/base（只加 3 个 LABEL、零字节新层）→ platform/sandbox`。
# 中间那层**唯一**的作用是盖一个 `platform.tmux` 章给注册期的根镜像检查看。代价是：
#
#   pull 13GB → 打标签 → push 13GB → **必须自建 registry 存它** → registry 跑在 Docker
#   里 → Docker 一停整条链断（2026-08 真断过：用户一个 Task 都建不出来）。
#
# 而那个章本来就不该刻在镜像里：`image-application.service.ts` 的注释自己说，它是
# **「运维方对自己指定的那张镜像做的一次声明」**。让运维方为了声明一件事而被迫成为
# 镜像作者，是这条规则最贵的部分。⇒ 声明搬到平台侧配置
# （`shared-kernel/domain/builtin-image.ts` 的 `builtinImageDeclaresTmux()` +
# `SANDBOX_DEFAULT_IMAGE_TMUX`），这一层只留**真正装了东西**的内容。
#
# ⚠️ **防谎报仍然靠运行期 `command -v tmux`**（⇒ `IMAGE_CONTRACT_VIOLATION`）。
# 注册期拦的是「不声明」，运行期拦的是「谎报」——两个时刻、两个码，谁也替代不了谁。
#
# ── 为什么直接 FROM 上游 ────────────────────────────────────────────────────────
# 上游对这张镜像的定位是 **"pre-configured, intended for direct deployment"**：拿来直接
# 用的，不是拿来派生的。实测（v1.11.0）它自带 **tmux 3.2a**、node v22.23.0、
# **codex 0.139.0**，唯独**没有 claude-code**。所以派生层只做两件事：补上缺的那个、
# 把落后的那个升上去。
#
# ── 为什么要预装（04 §7 ★ 的 753 秒）─────────────────────────────────────────
# 现装 claude-code 实测 **753 秒（12.5 分钟）**，那 12.5 分钟今天发生在**每一个**
# claude-code Task 的「启动实例」格里。预装把它挪到「发布一次」——同样的字节，付一次
# 而不是每次。
#
# ⚠️ **现装兜底不因此移除**：自定义镜像可以 FROM 本镜像而不再预装任何东西，那时
# install plan 现装仍然是唯一的路，而血统保证了 node 在 ⇒ 它一定装得上。
ARG BASE=ghcr.io/agent-infra/sandbox:latest
FROM ${BASE}

# ⚠️ **钉版本，不用 `@latest`。** 04 §7 整节的主张是「不可变坐标」：平台把 digest 冻进
# 库里，好让同一个 Task 每次跑的是同一份 bits。如果 Dockerfile 写 `@latest`，那么**同一
# 份源码在不同的日子会产出不同的镜像**——digest 还是不可变的，但你再也无法从仓库回答
# 「这个 digest 里装的是哪个版本」。而且上游一个坏版本会在无人改动任何东西的情况下,
# 静悄悄地进到每一个 Task 里。
#
# 升级流程是**改这两行 + 重新构建 + 让 SANDBOX_DEFAULT_IMAGE 指过去**，于是「升级」在
# git 历史里是一次可审计、可回滚的提交。
ARG CLAUDE_CODE_VERSION=2.1.251
ARG CODEX_VERSION=0.150.1

# ⚠️ **`npm install -g` 的默认 prefix 在这张镜像里是「每个用户一份」的，直接用会装了等于
# 没装。** 实测（v1.11.0）：镜像 ENV 里 `NPM_CONFIG_PREFIX=/root/.npm-global`，而
# 沙箱内命令是以 **`gem`** 跑的，它的 prefix 是 `/home/gem/.npm-global`。Dockerfile 的
# `RUN` 以 root 跑 ⇒ 装进 `/root/.npm-global/bin`，`gem` 的 PATH 上根本没有这个目录。
#
# ⚠️ **`/usr/local` 也不行**：`gem` 的 PATH 是
# `…/.fnm_shell/bin : /opt/nodejs/22/bin : … : /usr/local/bin`，而上游的 codex 已经在
# 前两个目录里（三个 shim 全部指向同一份 `…/installation/lib/node_modules`）。装进
# `/usr/local/bin` 的新 codex 会被前面那个**旧的**遮住——升级看起来成功，实际没生效。
#
# ⇒ prefix 取 **node 自己的安装前缀**（`/opt/fnm/node-versions/vX/installation`，也就是
# `/opt/nodejs/22` 指向的那个）。它是上述三个 shim 目录共同指向的那一份，改它就是三处
# 一起改；从 `node` 反推而不是写死，是为了上游换 node 大版本时不至于悄悄装错地方。
RUN set -eux; \
    NODE_PREFIX="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"; \
    test -d "$NODE_PREFIX/lib/node_modules"; \
    npm install -g --prefix "$NODE_PREFIX" \
        "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
        "@openai/codex@${CODEX_VERSION}"; \
    # 构建期自证，而不是等第一个 Task 去发现。三条都必须过：
    #   ① 两个 CLI 装到了 PATH 上、跑得起来、版本正是钉的那个（不是被旧 shim 遮住的）
    #   ② tmux 真的在（agent 会话由沙箱内的 tmux 持有）——被删掉的那个 LABEL 从来
    #      只是「声明」，这一行是**事实**
    "$NODE_PREFIX/bin/claude" --version | grep -F "${CLAUDE_CODE_VERSION}"; \
    "$NODE_PREFIX/bin/codex" --version | grep -F "${CODEX_VERSION}"; \
    command -v tmux; \
    tmux -V

# ⚠️ 这两个标签**留着**，删掉的只有 `platform.tmux`。它们从来不是合规判定：
#   · `platform.supportedRuntimes` → 只驱动 `RUNTIME_NOT_PREINSTALLED` 这个 **warning**
#     与 install plan 的提示，从不阻断（04 §7：现装永远走得通）
#   · `platform.resourceDefaults` → 创建实例时的默认配额
# 它们会被派生镜像继承且可能过期，所以「继承来的标签不作数」这条规则对它们同样成立。
LABEL platform.supportedRuntimes="codex,claude-code" \
      platform.resourceDefaults="{\"cores\":2,\"ramMb\":2048,\"diskMb\":10240}"
