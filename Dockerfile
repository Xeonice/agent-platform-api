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
COPY apps/api/package.json                     apps/api/
COPY packages/shared-kernel/package.json       packages/shared-kernel/
COPY packages/contracts/package.json           packages/contracts/
COPY packages/modules/credential/package.json  packages/modules/credential/
COPY packages/modules/project/package.json     packages/modules/project/
COPY packages/modules/runtime/package.json     packages/modules/runtime/
COPY packages/modules/sandbox/package.json     packages/modules/sandbox/
COPY packages/modules/terminal/package.json    packages/modules/terminal/
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

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
