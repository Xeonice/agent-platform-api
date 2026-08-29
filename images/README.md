# 平台预制镜像

**两张镜像，两个 Dockerfile** —— 一档一张（ADR 决策 C）。

| 目录                | 给谁        | 平台                                                        | 数据面                  | 实测大小   |
| ------------------- | ----------- | ----------------------------------------------------------- | ----------------------- | ---------- |
| `platform-sandbox/` | **aio**     | Linux（boxlite 在 Linux 上用不了，这是 aio 存在的全部理由） | 镜像自带的 HTTP/WS API  | **13GB**   |
| `platform-boxlite/` | **boxlite** | macOS（Virtualization.framework）                           | BoxLite native exec/PTY | **1.25GB** |

```
上游 ghcr.io/agent-infra/sandbox:latest   (13GB，自带 tmux 3.2a / node 22 / codex 0.139.0)
  └─ platform/sandbox                     (+ claude-code，codex 升到钉住的版本)

node:22-bookworm-slim
  └─ platform/boxlite                     (+ tmux/git + 两个 CLI)
```

## 为什么两档不共用一张

决策 A 修订把**数据面**拆成了两套，但**镜像没跟着拆**。留下的中间态谁都没得益：

> boxlite 跑着一个 13GB 的 aio 镜像，而那个镜像里的 HTTP 服务在 boxlite 档位下**一次都不会被调用**。

Chrome、VNC、VSCode server、Jupyter、MCP 那一整套，在微 VM 里是纯粹的死重。代价是实测的**冷启动 190 秒**（13GB 现拉 + 铺 rootfs），而这期间 `sandbox.status` 恒为 `starting`、CPU 0%、无网络活动 —— 用户判它卡死，排查的人第一眼也判它卡死。

⚠️ **两张镜像不能互换。** `platform/boxlite` 里**没有** `:8080` 的 agent，拿它跑 aio 会在 `waitForAgent` 那步响亮超时；`platform/sandbox` 拿去跑 boxlite 能跑，只是把那 190 秒又背回来。

⚠️ **「百 MB 级」是错的**（ADR 里的估计，实测订正）：1.25GB。其中 **550MB 是两个 CLI 的预编译二进制**（codex 318MB + claude-code 205MB），不可压缩 —— 两个包都只装当前平台那一份。剩下 590MB 是 `node:22-bookworm-slim`，106MB 是 apt。结论（小一个数量级）仍然成立，数字别照抄。

## 2026-08：中间那层 `platform/base` 被删掉了

它曾经长这样：

```
上游
  └─ platform/base     = 上游 + 3 个 LABEL（LABEL 不产生层 ⇒ 零字节新层）
      └─ platform/sandbox = base + claude-code
```

中间那层**唯一**的作用，是盖一个 `platform.tmux` 章给注册期的根镜像检查看。代价是一条纯属人为的依赖链：

> pull 13GB → 打标签 → push 13GB → **必须自建 registry 存它** → registry 跑在 Docker 里 → Docker 一停整条链断（2026-08 真断过：用户一个 Task 都建不出来）。

而那个章本来就不该刻在镜像里 —— 代码注释自己写着，它是**「运维方对自己指定的那张镜像做的一次声明」**。让运维方为了说一句话而被迫成为镜像作者，是这条规则最贵的部分。

⇒ 声明搬到平台侧配置：`SANDBOX_DEFAULT_IMAGE_TMUX`，兜底是平台内置的已知镜像表（`shared-kernel/domain/builtin-image.ts`）。

⚠️ **防谎报没有变**：一张删掉 tmux 的镜像照样能被声明成 `true`。抓它的从来是运行期沙箱内那次 `command -v tmux`（⇒ `IMAGE_CONTRACT_VIOLATION`）。注册期拦的是「不声明」，运行期拦的是「谎报」——两个时刻、两个码，谁也替代不了谁。

## 派生层为什么只装 CLI

上游对这张镜像的官方定位是 **"pre-configured, intended for direct deployment"**：拿来直接用的，不是拿来派生的。实测 v1.11.0：

|               | 上游有吗   | 派生层做什么                          |
| ------------- | ---------- | ------------------------------------- |
| tmux 3.2a     | ✅         | 不动（构建期 `command -v tmux` 自证） |
| node v22.23.0 | ✅         | 不动                                  |
| codex         | ✅ 0.139.0 | 升到 `CODEX_VERSION`                  |
| claude-code   | ❌         | 装到 `CLAUDE_CODE_VERSION`            |

预装 claude-code 的理由是 **753 秒**：现装实测 12.5 分钟，而那 12.5 分钟今天发生在**每一个** claude-code Task 的「启动实例」格里。预装把它挪到「发布一次」。
（现装兜底不因此移除：自定义镜像可以什么都不预装，那时现装仍是唯一的路。）

## 两个必须知道的坑（都是实测踩出来的）

### ① `npm install -g` 的默认 prefix 是**每个用户一份**的

镜像 ENV 里 `NPM_CONFIG_PREFIX=/root/.npm-global`，而**沙箱内的命令是以 `gem` 跑的**（`/v1/bash/exec` → `whoami` = `gem`），它的 prefix 是 `/home/gem/.npm-global`。
Dockerfile 的 `RUN` 以 root 跑 ⇒ 装进 `/root/.npm-global/bin`，`gem` 的 `PATH` 上**根本没有这个目录**。装了等于没装，而且不会有任何报错。

### ② `/usr/local` 也不行 —— 新的会被旧的遮住

`gem` 的 PATH：

```
/opt/gem/bin : /home/gem/.fnm_shell/bin : /opt/nodejs/22/bin : … : /home/gem/.npm-global/bin : … : /usr/local/bin
```

上游的 codex 已经在**前面**那两个目录里（三个 shim 全部指向同一份
`/opt/fnm/node-versions/v22.23.0/installation/lib/node_modules`）。装进 `/usr/local/bin` 的新 codex 会被前面那个旧的遮住 —— 升级看起来成功，实际没生效。

⇒ prefix 取 **node 自己的安装前缀**，从 `node` 反推：

```sh
NODE_PREFIX="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"
npm install -g --prefix "$NODE_PREFIX" …
```

它就是那三个 shim 目录共同指向的那一份，改它就是三处一起改。

⚠️ **在跑着的容器里 `npm install` 验证不了这件事。** 实测：`docker exec` 装完之后，
`docker exec` 看得见新版本，而**沙箱 API 的 bash 会话看不见**（它的 `/opt/nodejs/22/bin`
里没有新文件，mtime 还是镜像构建日期）—— 沙箱服务跑在自己的 mount namespace 里。
要验证只有一条路：**构建镜像、起一个新容器、经 `/v1/bash/exec` 问**。

## 为什么钉版本而不是 `@latest`

04 §7 整节的主张是「不可变坐标」：平台把 digest 冻进库里，好让同一个 Task 每次跑的是同一份 bits。`@latest` 会让**同一份源码在不同的日子产出不同的镜像** —— digest 还是不可变的，但你再也无法从仓库回答「这个 digest 里装的是哪个版本」。而且上游一个坏版本会在无人改动任何东西的情况下，静悄悄地进到每一个 Task 里。

升级 = 改 `ARG` 两行 + 重新构建 + 让 `SANDBOX_DEFAULT_IMAGE` 指过去。于是「升级」在 git 历史里是一次可审计、可回滚的提交。

## 构建

```sh
# aio 档
docker build -t <registry>/platform/sandbox:<tag> images/platform-sandbox
# boxlite 档
docker build -t <registry>/platform/boxlite:<tag> images/platform-boxlite
```

覆盖版本：

```sh
docker build \
  --build-arg CLAUDE_CODE_VERSION=2.1.251 \
  --build-arg CODEX_VERSION=0.150.1 \
  -t platform/sandbox:dev images/platform-sandbox
```

构建期自证三条，任一不过即失败：两个 CLI 的版本正是钉的那个（不是被旧 shim 遮住的）、`tmux -V` 有输出。

## ⚠️ 别在跑着的容器里 `npm install` 来验证镜像内容

实测（v1.11.0）：`docker exec` 装完之后，`docker exec` 看得见新版本，而**沙箱 API 的 bash
会话看不见** —— 它的 `/opt/nodejs/22/bin` 里没有新文件，mtime 还是镜像构建日期。沙箱服务
跑在自己的 mount namespace 里。

⇒ 验证只有一条路：**构建镜像、起一个新容器、经 `/v1/bash/exec` 问**。

## 要不要 push？—— 取决于跑哪个 provider

| provider             | 镜像从哪来                     | 需要 registry 吗                                                                                                     |
| -------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **aio**（docker）    | docker daemon 的**本机镜像库** | ❌ **不需要**。`docker build -t platform/sandbox:dev` 之后把 `SANDBOX_DEFAULT_IMAGE` 指过去就能用                    |
| **boxlite**（微 VM） | 必须从 registry 拉             | ✅ 需要（`SANDBOX_BOXLITE_REGISTRY`；BoxLite 自己的 image store 不支持断点续传，大镜像还要经 `localhost:5001` 中转） |

⚠️ **这条差别就是「自建 registry 是不是必需」的答案**：只跑 aio 的单机部署不需要自建 registry —— 而删掉 `platform/base` 之前它是必需的，因为那张只为盖章的中间镜像必须有地方存。

## 血统（04 §7 ★血统）

自定义镜像必须 `FROM` 本镜像（或它的派生）。注册期比对 `rootfs.diff_ids` 前缀 —— 那是**可验证的**，不像标签只是一句自述。

实测（2026-08，真镜像）：上游 77 层，`platform/sandbox` 78 层，第一层 diff_id 一字不差 ⇒ 前缀规则成立。
