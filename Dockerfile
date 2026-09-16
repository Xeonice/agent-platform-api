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
#   docker build \
#     --build-arg APP_VERSION="$(git describe --tags --always)" \
#     --build-arg APP_COMMIT="$(git rev-parse HEAD)" \
#     --build-arg APP_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
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
