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

| 机制                         | 落点                                                                                                                   | 作用                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **分层边界**                 | `eslint.config.mjs` boundaries                                                                                         | domain/application/interface/infrastructure 越界即 error                    |
| **时间/随机可控化**          | `no-restricted-syntax` 禁 `new Date()`/`Date.now()`/`randomUUID()`；仅 `platform/time`、`access-passcode` 豁免         | 统一走 Clock / IdGenerator 端口，消除 flaky                                 |
| **同步事务**                 | `UnitOfWork.run((tx)=>T): T`、`saveSync(tx,agg): void`                                                                 | 类型层堵死事务内 `await`（P0-2）                                            |
| **zod 单源 + OpenAPI**       | `contracts` zod → `createZodDto` → `patchNestJsSwagger()`；`setGlobalPrefix('api')` + `jsonDocumentUrl:'openapi.json'` | 一份 schema 出 REST DTO + Swagger + MCP inputSchema                         |
| **contract-testkit**         | `@platform/contracts/testkit`（外部 provider 契约工具；独立验收）                                                      | 第三方/内建 provider 接口工具；不把内存夹具当真实 provider 通过             |
| **vitest + supertest + MCP** | `test:pure` / `test:service` / `test:sqlite` / `test:protocol`                                                         | 真实策略、真实服务与当前 SQLite、完整 Nest HTTP/WS/MCP                      |
| **Drizzle better-sqlite3**   | `schema/*.sqlite.ts`（text+CHECK，不用 pgEnum/.array()，JS Date）+ `./drizzle` 迁移 + 新数据库事务验收                 | 单机零依赖、PG 双方言可迁移                                                 |
| **部署 harness**             | `docker-compose.yml`（docker-socket-proxy 限权 + 127.0.0.1 绑定）+ `NoopAuthGuard`/`PasscodeGuard`                     | 容器逃逸面收敛 + 默认回环 + 访问口令骨架                                    |
| **CI 九步**                  | 主仓 `deploy/jenkins/native-ci.groovy`                                                                                 | install → typecheck → lint → format → 验收及执行报告 → build → OpenAPI diff |

## 命令

```bash
pnpm typecheck        # tsc -b（project references，全量类型检查 + 产出 dist）
pnpm lint             # eslint（boundaries + no-restricted-syntax），CI 加 --max-warnings=0
pnpm format:check     # prettier
pnpm test                # 新验收全部四层，协议层串行
pnpm test:pure           # 真实纯策略与校验
pnpm test:service        # 真实服务，受控外部资源
pnpm test:sqlite         # 当前 schema、真实 repository/UoW、竞态与回滚
pnpm test:protocol       # 完整 Nest + HTTP / WS / MCP
pnpm test:acceptance:report # 实际运行 JSON 与源哈希，不把 AC 计划当通过
pnpm check:acceptance    # 在主仓中核对现行规范及场景映射
pnpm build            # 构建
pnpm openapi:emit     # 产出 openapi.json（CI diff 入库）
```

### 验收范围

测试位于 `acceptance/{domain}/{pure,service,sqlite,protocol}`，依据主仓 `docs/product/requirements` 的 Given/When/Then 验证产品规则，包含并发、SQLite、SSH 和 PTY 回归。SQLite 场景使用当前初始化 schema；生产数据更新仍由部署维护流程保护。

协议层装配实际 AppModule、repository、guard 和业务服务，HTTP/MCP/WS 经过真实网络协议。外部沙箱/OCI 元数据使用受控资源夹具，终端使用真实子进程字节流，Git 使用本地真实 smart HTTP 仓库；这些结果不代表真实 Docker、BoxLite 或厂商帐号 OAuth 已验收。外部环境验收必须另列条件与实际结果。

全部 1016 个 AC 保留在 `acceptance/manifest.json`；未映射场景保持 planned。后端支持与整条包含 UI 的 AC 明确分开。实际执行结果由 `acceptance/execution-report.json` 记录，不以文件数、静态断言句数或 AC 总数替代测试通过数。

### 验证 harness 真能拦

```bash
# 1) 越界：让 application 直接 import infrastructure 具体类 → lint error
#    在 sandbox-application.service.ts 顶部加：
#    import { SqliteSandboxRepository } from '../infrastructure/persistence/sqlite/sandbox.repository.impl';
pnpm lint    # → boundaries/element-types: 'application' is not allowed to import 'infrastructure'

# 2) 时间：在任意 domain/application 文件写 new Date() → lint error
pnpm lint    # → no-restricted-syntax: Use the Clock port — new Date() is banned
```

## 访问口令与换口令

全新数据目录默认生成 16 位访问口令，只在首次启动的 stdout 横幅显示一次；平台日志文件与导出日志包不包含明文。请当场保存。Docker 的 json-file 日志驱动会保留 stdout，`docker logs` 仍能查到第一次输出。后续启动只打印启用状态。显式关闭自动生成可设置 `ACCESS_PASSCODE_AUTO_GENERATE=false`；这不关闭已有口令。

忘记口令或从部署侧换口令：设置 `ACCESS_PASSCODE=<新口令>` 后重启。该变量优先于库中口令，存在时接口拒绝修改。已解锁后也可调用 `PUT /api/system/access-passcode`，请求 `{"action":"regenerate"}`，新口令只返回这一次；默认保留已有浏览器会话。

要同时让已登录的浏览器失效，请使用 `{"action":"regenerate","invalidateSessions":true}`。旧会话立即失效，发起操作的浏览器随响应获得新会话。若部署配置固定了 `PASSCODE_COOKIE_SECRET`，接口拒绝此选项且不改变口令；请改为新的 `PASSCODE_COOKIE_SECRET` 后重启。环境变量换口令时也可同时轮换该密钥。浏览器会话固定 7 天，不随访问顺延。

默认回环地址也需要口令。只有显式设置 `ACCESS_PASSCODE_ALLOW_LOOPBACK=true` 时，直接来自 `127.0.0.0/8` 或 `::1` 的 REST 请求免口令；非回环来源仍需要口令。来源取实际 socket 地址，不信任转发头；这个开关不替代 Host / Origin 校验。
