# API 验收测试

规范来源为主仓 `docs/product/requirements/{WB,PRJ,LCH,SBX,AUTH,CRD,IMG,AUT,SYS,ACC,DEP}.md`。每个场景验证 Given/When/Then 中属于后端的数据、边界与协议；前端文案、焦点、布局和浏览器操作由 web 验证。

- `pure`：真实纯策略、校验与状态投影，无 IO 替身。
- `service`：真实 application/service，外部 provider/CLI/clock 受控；事务关键场景使用 SQLite。
- `sqlite`：真实当前初始化 schema、生产 repository/UoW、事务回滚与条件重验。
- `protocol`：完整 AppModule/bootstrap、真实 HTTP/WS/MCP 壳，随机端口与独立 DATA_ROOT。仅替换外部网络/provider，不替换待测服务或 guard。

`manifest.json` 是全部 AC 的计划与映射，未关联执行场景保持 planned；支持后端的测试不等同整条 UI AC 验收。执行结果由测试运行器给出，清单数量不能作为“通过数”。

在 API 根目录使用 Node 22：

```sh
pnpm test:acceptance:report
pnpm test:pure
pnpm test:service
pnpm test:sqlite
pnpm test:protocol
pnpm test:contract
pnpm check:acceptance
node scripts/check-fake-provider-caps.mjs
node scripts/check-wire-snapshots.mjs
```

`check:acceptance` 要从包含主仓产品规范的 workspace 执行；独立 API CI 运行实际场景与报告。`execution-report.json` 由每次验收生成，并由 Jenkins 构建归档，保存已执行测试、实际 Vitest matcher 调用数和测试源 SHA-256。静态 expect 表达式数量单独记录，不能充当实际断言数。

报告的 `tests` 包括显式 skipped/todo；`executedTests` 与 `matcherEvidenceRecords` 仅计实际 passed/failed 执行项，跳过用例不伪造 matcher 证据。每条 matcher 证据保留文件和测试名。可用 `pnpm test:acceptance:report -- acceptance/contracts` 定向复跑契约报告；CI 无参数执行完整范围。

`pnpm test:contract` 显式先运行 `acceptance/contracts/pure` 的 Golden 静态契约，再运行 `acceptance/contracts/protocol/owner-extension.spec.ts` 的真实 Owner HTTP 扩展验收；任一阶段失败或未发现测试均失败。Golden 将现存公共 testkit 用于真实内建 `aio`／`boxlite`、`codex`／`claude-code` 与 OCI 实现，只控制 OCI 元数据传输和 Runtime 的 exec 记录，不调用 CLI、外网或用户凭证。默认 `test:acceptance:report` 也会发现这两类目录，因此 CI 全量验收包含它们。

共同测试入口在运行 `protocol` 前使用当前 Node 和本地 TypeScript 执行增量 `tsc -b`；编译失败即停止，不启动协议测试。`test:protocol`、`test:contract` 与全量报告均包含这一步，Owner 的真实子进程不会依赖手工 build 或旧 dist；仅运行 pure/service/sqlite 不增加该构建步骤。

Golden 的 Provider 静态条款不创建 Guest：SP-01／DP 实机条款会显式显示 skipped，Claude 未声明 refresh 能力的条款也保留适用性说明；这些不能算作实机、模型或沙箱连续性通过。Owner 协议验收使用独立临时目录和测试第三方 Provider，验证真实注册、发现和路由，不代表 Docker／BoxLite Guest 已创建。

主仓 `pnpm --dir e2e-contract test` 使用真实 Chromium、生产 Next.js、完整编译后 Nest 和干净 SQLite。报告位于 `e2e-contract/artifacts/execution-report.json`，记录实际场景、运行时断言与外部夹具边界；真实 Docker/BoxLite、厂商 OAuth 和 native PTY 另行验收。

公开部署验收使用真实 HTTP/MCP/Engine.IO WebSocket、临时屏障文件和干净 SQLite。来源政策与可信 CF 客户端 IP 另有纯策略边界验收。`GET /api/deployment/status` 的 `ready` 仅检查 SQLite quick_check/外键、默认 provider/BoxLite 原生 SDK 模块加载与默认镜像登记状态，不创建 VM；`idle` 是当次可观测空闲，发布控制器必须先创建 `DEPLOYMENT_DRAIN_FILE` 并连续等待空闲，禁止同数据目录双 API。更新屏障阻止新的写请求与 WS 握手，既有连接保留并继续阻挡更新。运营场景在 scenario-map 中明确记为 operational-deployment，不虚增产品 AC 数量。
