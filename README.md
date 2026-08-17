# agent-platform-api

后端仓库：**NestJS 11 + Node 22 + TypeScript strict + pnpm workspaces（modular monolith）+ zod 单源 + Drizzle/better-sqlite3 + MCP/REST 双协议**。

结构与分层的权威文档：[`docs/backend/01`](../docs/backend/01-后端目录结构与DDD分层.md)（本仓在 monorepo 的 `api/` 子目录内实现）。

---

## 快速开始

```bash
pnpm install
pnpm db:generate     # 从 schema 生成 drizzle 迁移（首次已提交在 ./drizzle）
pnpm build           # tsc -b 全量构建（project references）
pnpm start           # node apps/api/dist/main.js
# → GET http://127.0.0.1:3000/api/health  {"status":"ok"}
# → http://127.0.0.1:3000/openapi.json     完整 OpenAPI
# → http://127.0.0.1:3000/docs             Swagger UI
```

默认只监听 `127.0.0.1`（shared/11 §3，审计 P0-3）。改 `HOST=0.0.0.0` 会在启动日志打醒目告警。

## 工作区结构

```
api/
├── packages/
│   ├── shared-kernel/        # Clock / IdGenerator / UnitOfWork(同步) / EventBus 端口 + AggregateRoot + branded ID
│   ├── contracts/            # zod 单源（schemas/）+ 统一错误 envelope + registry tokens
│   │   └── src/testkit/      # @platform/contracts/testkit —— golden 契约测试执行器（CLI-VERSION-MATRIX 占位）
│   └── modules/
│       └── sandbox/          # 一个限界上下文，DDD 四层同构
│           └── src/{domain,application,infrastructure,interface}/
└── apps/api/                 # NestJS 装配：main / app.module / bootstrap(swagger,mcp,guards) / platform(persistence,time,events,system,access-passcode)
```

> 其余六个上下文（project / runtime / image / credential / terminal / automation）遵循与 `sandbox` **完全相同的四层形态**（docs/backend/01 §2），按同一套 harness 增量落地。本次脚手架只把 `sandbox` 做成可编译运行的最小闭环。

## DDD 四层与依赖规则（eslint-plugin-boundaries 强制）

```
interface ──▶ application ──▶ domain ◀── infrastructure（实现端口）
                  └────────▶ contracts ◀──────────┘
```

| 层             | 允许依赖                                 | 关键禁令                                          |
| -------------- | ---------------------------------------- | ------------------------------------------------- |
| domain         | domain、shared-kernel                    | 任何三方 IO 库、框架代码、**contracts**           |
| application    | domain、contracts、shared-kernel         | **直接 import infrastructure 具体实现**（走端口） |
| infrastructure | domain、contracts、shared-kernel、三方库 | —                                                 |
| interface      | application、contracts                   | 触碰 domain 内部细节                              |
| contracts      | 仅自身                                   | 反向依赖任何实现                                  |

组合根 `*.module.ts`（在 `interface/`）是唯一允许把端口接到实现的地方，boundaries 用 `module-root` 元素单独放行。

## Harness 门禁（从第一个 commit 起强制）

| 机制                         | 落点                                                                                                                   | 作用                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **分层边界**                 | `eslint.config.mjs` boundaries                                                                                         | domain/application/interface/infrastructure 越界即 error                                                 |
| **时间/随机可控化**          | `no-restricted-syntax` 禁 `new Date()`/`Date.now()`/`randomUUID()`；仅 `platform/time`、`access-passcode` 豁免         | 统一走 Clock / IdGenerator 端口，消除 flaky                                                              |
| **同步事务**                 | `UnitOfWork.run((tx)=>T): T`、`saveSync(tx,agg): void`                                                                 | 类型层堵死事务内 `await`（P0-2）                                                                         |
| **zod 单源 + OpenAPI**       | `contracts` zod → `createZodDto` → `patchNestJsSwagger()`；`setGlobalPrefix('api')` + `jsonDocumentUrl:'openapi.json'` | 一份 schema 出 REST DTO + Swagger + MCP inputSchema                                                      |
| **contract-testkit**         | `@platform/contracts/testkit` + `test/contract/*`（CI 必跑）                                                           | 第三方/内建 provider 跑同一套 golden 契约                                                                |
| **vitest + supertest + MCP** | `test:unit` / `test:integration` / `test:contract` / `test:e2e`                                                        | domain 零 mock、集成真库、e2e 同场景 REST+MCP                                                            |
| **Drizzle better-sqlite3**   | `schema/*.sqlite.ts`（text+CHECK，不用 pgEnum/.array()，JS Date）+ `./drizzle` 迁移 + 迁移测试                         | 单机零依赖、PG 双方言可迁移                                                                              |
| **部署 harness**             | `docker-compose.yml`（docker-socket-proxy 限权 + 127.0.0.1 绑定）+ `NoopAuthGuard`/`PasscodeGuard`                     | 容器逃逸面收敛 + 默认回环 + 访问口令骨架                                                                 |
| **CI 九步**                  | `.github/workflows/ci.yml`                                                                                             | install → typecheck → lint → unit → contract(必跑) → integration → e2e(必跑) → build → openapi.json diff |

## 命令

```bash
pnpm typecheck        # tsc -b（project references，全量类型检查 + 产出 dist）
pnpm lint             # eslint（boundaries + no-restricted-syntax），CI 加 --max-warnings=0
pnpm format:check     # prettier
pnpm test             # 全部 vitest 项目
pnpm test:unit        # 仅 domain 零 mock 单测
pnpm test:integration # drizzle saveSync 往返 + 迁移测试
pnpm test:contract    # contract-testkit（必跑）
pnpm test:e2e         # supertest /api/health + MCP client 冒烟（必跑）
pnpm build            # 构建
pnpm openapi:emit     # 产出 openapi.json（CI diff 入库）
```

### 运行时（docker / boxlite）e2e 前置

部分 e2e 需真实运行时，缺前置会**响亮 skip**（不假过）：

- **docker / aio**：需 Docker daemon（`docker info` 可达）。
- **boxlite（micro-VM，决策 B）**：需 macOS Apple Silicon 装好 `@boxlite-ai/boxlite` 原生二进制，且**本地 registry 预置 AIO 镜像**（BoxLite 独立 image store 无断点续传，须经中转）：
  ```bash
  docker run -d -p 5001:5000 --name local-registry registry:2
  docker pull ghcr.io/agent-infra/sandbox:latest                                   # arm64
  docker tag  ghcr.io/agent-infra/sandbox:latest localhost:5001/agent-infra/sandbox:latest
  docker push localhost:5001/agent-infra/sandbox:latest
  ```
  provider 的 `imageRegistries` 已含 `docker.io`（bootstrap base，**必须保留**）+ `localhost:5001`（可用 `SANDBOX_BOXLITE_REGISTRY` 覆盖）。首个 Box 冷启含镜像入 store ~220s、之后热启 ~7s。选型与工程注记见**文档仓 `SANDBOX-RUNTIME-DECISIONS.md`**。

## 冒烟切片（本次交付验证的最小闭环）

- `GET /api/health` → `ok`（口令豁免）；`/openapi.json` 暴露。
- `sandbox` 上下文：`Sandbox` 聚合 + `SandboxStatus` 12 值转移表 + 零 mock domain 单测（`stopped→starting` 合法、`pending→running` 非法）。
- 同步 `UnitOfWork` + better-sqlite3 迁移 + `SqliteSandboxRepository.saveSync` + 集成测试（写入后读回、CHECK 拦截越界枚举）。
- 一个 MCP tool + 一个 REST controller 共注入同一 `SandboxApplicationService`；supertest e2e + 真实 MCP client（SDK InMemoryTransport）冒烟。
- boundaries 越界与 `new Date()` 均能被 lint 拦下（见下）。

### 验证 harness 真能拦

```bash
# 1) 越界：让 application 直接 import infrastructure 具体类 → lint error
#    在 sandbox-application.service.ts 顶部加：
#    import { SqliteSandboxRepository } from '../infrastructure/persistence/sqlite/sandbox.repository.impl';
pnpm lint    # → boundaries/element-types: 'application' is not allowed to import 'infrastructure'

# 2) 时间：在任意 domain/application 文件写 new Date() → lint error
pnpm lint    # → no-restricted-syntax: Use the Clock port — new Date() is banned
```
