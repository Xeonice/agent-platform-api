-- 04 §2.2 / 13 §2.1：`sandboxes` 的两列 provider 私有字段收成**一列不透明 JSON**。
--
--   agent_endpoint_port (integer) ┐
--   agent_auth_token    (text)    ┴─→ provider_state (text, JSON)
--
-- ⚠️ **为什么要收**：这两列的名字是**一种 provider 的一种数据面实现**的词汇——AIO 镜像里
-- 那个 HTTP agent 的「端口」和「bearer token」。它们从契约（`SandboxHandle`）一路穿透到
-- 领域聚合（`Sandbox`）再到这张表，而 `SandboxHandle` 的注释同时还写着「平台把它当不透明的」
-- ——字段名恰恰不透明。代价不是抽象洁癖：它让「沙箱里必须跑着一个 agent HTTP 服务」成了
-- **平台级假设**，而用原生 exec 通道的 provider（boxlite 微 VM）根本没有这两样东西。
--
-- ⚠️ **本列的内容由 provider 定义，平台不解释、不校验、不迁移。** 下面这条 UPDATE 是
-- 唯一一次例外——它必须知道旧的两列对应哪两个键，因为**没有别人知道**。
--
-- ⚠️ **DROP COLUMN 不可逆**：跑完这条，旧值只存在于 `provider_state` 里。所以顺序是
-- 硬的——先 ADD、**再搬数据**、最后才 DROP。drizzle-kit 生成的版本只有 ADD + DROP
-- （它不知道两列和新列的语义关系），中间那条 UPDATE 是手工补的；漏了它，所有存量沙箱
-- 会在升级后**丢掉 agent 凭证**，表现为「重启后连不上自己的沙箱」，而且无法从运行时反推
-- （容器只持有公钥那一半）。
--
-- ⚠️ **NULL 的键不写进 JSON**：`{"agentAuthToken":null}` 与「没有这个键」读回来同义，
-- 但前者看起来像"有这么个东西、值是空"，排查时多一次误导（与 `agentProviderState()` 同源）。
-- 两列都为 NULL 的行保持 `provider_state IS NULL`，不写 `'{}'`——同理。
--
-- ⚠️ 用 ADD + DROP 而不是「建新表-搬数据-改名」：`sandboxes` 被 `runtime_installations`
-- 和 `sandbox_state_transitions` 以 ON DELETE CASCADE 引用着，重建它意味着在 FK 关闭的
-- 窗口里 DROP 一张被引用的表；SQLite 3.35+ 原生支持 DROP COLUMN，没有重建的理由
-- （与 0011/0012 同一条纪律）。这两列没有任何索引/触发器引用，DROP 得掉。
ALTER TABLE `sandboxes` ADD `provider_state` text;--> statement-breakpoint
UPDATE `sandboxes`
SET `provider_state` = json_patch(
      CASE WHEN `agent_endpoint_port` IS NULL THEN '{}'
           ELSE json_object('agentEndpointPort', `agent_endpoint_port`) END,
      CASE WHEN `agent_auth_token` IS NULL THEN '{}'
           ELSE json_object('agentAuthToken', `agent_auth_token`) END)
WHERE `agent_endpoint_port` IS NOT NULL OR `agent_auth_token` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `agent_endpoint_port`;--> statement-breakpoint
ALTER TABLE `sandboxes` DROP COLUMN `agent_auth_token`;
