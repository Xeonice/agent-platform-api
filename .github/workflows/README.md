# Jenkins CI

API 静态检查、真实四层验收和 Linux ARM64 原生依赖检查由 Mac mini 的 `agent-platform-native-ci` 执行。生产镜像、备份、空闲屏障和安全替换由 `agent-platform-api` 作业管理。

`agent-platform-mutation` 在隔离构建节点运行 nightly/full 或 PR changed-file 报告，结果保持非阻断。`agent-platform-sandbox-images` 按 `config/sandbox-publish.json` 构建两档、两架构镜像，并验证 GHCR 匿名 digest；默认镜像一致性检查消费同一配置。

流水线与受信发布工具位于主仓 `deploy/jenkins` 和 `deploy/containers`。GitHub 状态由专属 Jenkins App 回写；此目录不包含可执行的 GitHub Actions 工作流。
