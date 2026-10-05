# API design-v2 acceptance tests

规范来源为主仓 `docs/design-v2/gap/product/{WB,PRJ,LCH,SBX,AUTH,CRD,IMG,AUT,SYS,ACC,DEP}.md`。每个场景验证 Given/When/Then 中属于后端的数据、边界与协议；前端文案、焦点、布局和浏览器操作由 web 验证。

- `pure`：真实纯策略、校验与状态投影，无 IO 替身。
- `service`：真实 application/service，外部 provider/CLI/clock 受控；事务关键场景使用 SQLite。
- `sqlite`：真实当前初始化 schema、生产 repository/UoW、事务回滚与条件重验。项目未上线，不重建旧 schema 升级测试。
- `protocol`：完整 AppModule/bootstrap、真实 HTTP/WS/MCP 壳，随机端口与独立 DATA_ROOT。仅替换外部网络/provider，不替换待测服务或 guard。

`manifest.json` 是全部 AC 的计划与映射，未关联执行场景保持 planned；支持后端的测试不等同整条 UI AC 验收。执行结果由测试运行器给出，清单数量不能作为“通过数”。

本轮新写的并发撤销/删除、SQLite、CLI 字节流回归迁入各域；旧 HEAD suite 在新场景和映射可评审、关键 gates 通过后移除，不将旧 suite 全量换名。

在 API 根目录使用 Node 22：

```sh
pnpm test:acceptance:report
pnpm test:pure
pnpm test:service
pnpm test:sqlite
pnpm test:protocol
pnpm check:acceptance
node scripts/check-fake-provider-caps.mjs
node scripts/check-wire-snapshots.mjs
```

`check:acceptance` 要从包含主仓设计文档的 workspace 执行；独立 API CI 运行实际场景与报告，不凭缺失的外部文档生成通过结论。`execution-report.json` 保存已执行测试、零跳过检查、实际 Vitest matcher 调用数和测试源 SHA-256。静态 expect 表达式数量单独记录，不能充当实际断言数。

本轮已退休旧 tracked API 测试与附属文件 241 个（216 个 spec、13 个 CLI 捕获文件、12 个 helper）。迁入的 25 个来源是本次迁移中新写的回归，详见 `adopted-regressions.json`。最终实跑结果为 42 个新 spec、165/165 个测试通过、0 skipped；后续运行以 `execution-report.json` 为准。

主仓 `pnpm --dir e2e-contract test` 使用真实 Chromium、生产 Next.js、完整编译后 Nest 和干净 SQLite。持久报告位于主仓 `artifacts/migration-audit/cross-execution-report.json`，明确实际场景、运行时断言与外部夹具边界；它不代表厂商 OAuth、真实 Docker/BoxLite 或 native PTY 已验收。
