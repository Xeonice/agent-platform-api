# 单机部署镜像(docs/shared/11 §1)。compose 的 `api.build: .` 指向本文件。
#
# 两点值得先说清楚:
#
#  ① **迁移在启动时跑,不需要单独的 migrate 步骤** —— `PlatformModule` 在
#     `createConnection` 之后直接 `runMigrations`。因此 `drizzle/` 必须进镜像,
#     且工作目录必须是 /app:`migrationsDir()` 解析的是 `cwd()/drizzle`。
#
#  ② **better-sqlite3 是原生模块** —— 必须在**与运行阶段同一个 libc** 的镜像里
#     编译。这也是这里用 bookworm(glibc) 而不是 alpine(musl) 的原因:musl 上没有
#     预编译产物,每次都要从源码编译,而且和宿主 glibc 的产物不通用。
#     `.dockerignore` 排除 node_modules 正是为了不让宿主编译的 .node 混进来。

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# better-sqlite3 需要 node-gyp 工具链;仅 builder 阶段需要,不进运行镜像
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# 先只拷清单与锁文件,让依赖层能被缓存(源码一改不至于重装依赖)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# ⚠️ 用 glob 而不是逐行手抄 workspace 成员。手抄的版本与 `pnpm-workspace.yaml` 的
# glob（`packages/modules/*` + `apps/*`）没有任何机制保持同步：新增一个模块而忘了
# 在这里加一行，`pnpm install --frozen-lockfile` 会在 builder 阶段直接报锁文件不匹配，
# 而错误信息不会告诉你少的是哪一个。glob 天然跟着 workspace 走。
#
# 仍然只拷 package.json（不拷源码）——这一层的全部意义就是让依赖层能被缓存，
# 源码一改不至于重装依赖。
COPY apps/api/package.json ./apps/api/
COPY packages/shared-kernel/package.json ./packages/shared-kernel/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/modules ./packages/modules-manifests-tmp
RUN set -eux; \
    for d in packages/modules-manifests-tmp/*/; do \
      m="packages/modules/$(basename "$d")"; \
      mkdir -p "$m"; cp "$d/package.json" "$m/package.json"; \
    done; \
    rm -rf packages/modules-manifests-tmp
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# ⚠️ 以 root 运行是**部署形态的选择**,不是疏忽:DATA_ROOT 是宿主 bind mount
# (11 §1.2「宿主路径 = 容器路径」),平台要在其中按 0700/0777 建目录给沙箱内的
# 非 root 用户用。容器内换非 root 会引入 uid 对不上的问题,而这个容器本身
# **不接受用户代码**——用户代码跑在它创建的兄弟容器里。真正的隔离边界在那儿,
# 以及只白名单 CONTAINERS/EXEC/IMAGES 的 docker-socket-proxy 上。

# ⛔⛔ **git 克隆跑在 api 进程(这个容器)里,不是在沙箱容器里** —— `simple-git` 只是对
# `child_process.spawn('git', …)` 的封装,`node:22-bookworm-slim` 这张基础镜像**不带
# git**(实测 `docker run --rm node:22-bookworm-slim sh -c 'command -v git'` 是空)。
# 不装的后果不是「某个功能报错」,是「建项目 / 同步基线 / 校验 Git 凭证」这三条路**全部
# 在容器里找不到 `git` 可执行文件而失败**,而这三条恰好是这个平台的入口功能:
#   · packages/modules/project/src/infrastructure/git/git-cloner.ts   —— 建项目克隆
#   · packages/modules/project/src/infrastructure/git/baseline-git.ts —— `branch -r` / `fetch --all`
#   · packages/modules/credential/src/infrastructure/git/git-ls-remote.tester.ts —— 凭证测试
#
# 装的三样,每样对应一条代码路径,将来想瘦身请先读完这三行再删:
#   · git            —— 上面三条路径共同需要的可执行文件本身。
#   · openssh-client —— `packages/modules/project/src/infrastructure/git/git-env.ts` 的
#     `mergeAuthEnv()` **总是**给每一次 git 调用注入 `GIT_SSH_COMMAND`(无凭证时兜底成
#     `ssh -F /dev/null …` 以关闭环境 SSH 身份;有凭证时指向平台落盘的私钥),而
#     credential 模块把 SSH 私钥列为一等公民的凭证类型(`git-auth.materializer.ts` /
#     `known-hosts.ts`)——只要有一个项目用 `git@`/`ssh://` 地址,git 的 ssh 传输层就会
#     去 spawn `ssh` 这个二进制,不装它,ssh 形态的私有仓 100% 失败(而 https 形态的仓
#     不会触发这条,所以本地拿一个 https 公开仓测过「能建项目」不代表这条已经补齐)。
#   · ca-certificates —— 装的是系统信任的 CA 根证书(`/etc/ssl/certs`)。Node 自己的
#     `fetch`(undici)带了内置证书链、不依赖这份系统信任库,**但 git 走 libcurl/OpenSSL,
#     读的是系统信任库**——不装它,任何 `https://` 地址的 clone / fetch / ls-remote 都会
#     以 `SSL certificate problem: unable to get local issuer certificate` 失败,
#     且报错信息和「网络不通」长得一样,容易被误判成防火墙问题。
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules          ./node_modules
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/dist         ./apps/api/dist
COPY --from=builder /app/packages              ./packages
COPY --from=builder /app/drizzle               ./drizzle
COPY --from=builder /app/package.json          ./package.json

# ── 版本三元组:构建期注入,运行期由 GET /api/system/version 原样报出 ──────────
# 平台版本是**主仓的 tag**(只有主仓钉得住两个 submodule 指针 = 一份可复现的部署状态),
# 而跑起来的是这个容器——它手上没有主仓,读不到那个 tag。所以只能在构建这一刻塞进来。
#
# ⚠️ **三个 ARG 都可以不传**,不传时 `ENV` 落成空串,`platform/config/env.ts` 把空串
# 归一成 `null`,端点如实回 `null`。⛔ 别给它们写默认值——一个写死的默认版本号会让
# 每一个忘了传 build-arg 的构建都报出同一个**看起来像真的**的版本。
#
#   ⚠️⚠️ **在 `api/` 里直接 `docker build` 时,版本号要从【主仓】取,不是这个仓。**
#   ⛔ 这里此前写的是裸的 `git describe --tags --always` —— 那是错的:submodule 有
#   自己独立的 `.git`,在 `api/` 里跑它拿到的是 **api 仓自己那条时间线**
#   (实测得到 `sandbox-image-v2-20-g1427649`),而平台版本只在主仓上打(`v0.1.0`)。
#   ⇒ 用 `--show-superproject-working-tree` 定位主仓,**不要**写 `git -C ..`:
#      后者依赖"主仓一定是上一级目录"这个假设,目录一挪就碎。
#
#   SUPER=$(git rev-parse --show-superproject-working-tree)
#   docker build \
#     --build-arg APP_VERSION="$(git -C "$SUPER" describe --tags --always)" \
#     --build-arg APP_COMMIT="$(git -C "$SUPER" rev-parse HEAD)" \
#     --build-arg APP_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
#
#   📌 多数人不需要这条 —— 正常部署是在**主仓根目录**跑 `docker compose up --build`
#      (见主仓 README §3),那里裸的 `git describe` 就是对的。
#
# ⚠️ 这三行放在**最后**是有意的:ARG 的值一变就会让它之后的每一层缓存失效,而版本号
# 每次构建都不一样。放在 COPY 前面等于每次构建都从头装一遍依赖。
ARG APP_VERSION=
ARG APP_COMMIT=
ARG APP_BUILT_AT=
ENV APP_VERSION=$APP_VERSION \
    APP_COMMIT=$APP_COMMIT \
    APP_BUILT_AT=$APP_BUILT_AT

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
