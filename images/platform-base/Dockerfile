# 平台预制**基础**镜像 —— 血统校验的锚点（04 §7）。
#
# 它只做一件事：在上游镜像上加一层 config（标签），**零字节新层**。
# 自定义镜像必须 `FROM` 它（或它的派生），平台靠 `rootfs.diff_ids` 前缀校验血统 ——
# 那是**可验证的**，不像标签只是一句自述。
#
# ⚠️ 这一层的 `platform.tmux` 标签只对**根镜像**有意义：它是运维方对自己指定的这张
# 镜像做的一次声明，用来在开机时抓住"指错了镜像"，而不是用来防谎报（防谎报靠运行期
# `command -v tmux` 实测）。派生镜像会**继承**这个标签，因此在派生场景里它不作数 ——
# 实测：`demo/custom` 一个 platform.* 都没写，却继承了全部三个。
ARG BASE=ghcr.io/agent-infra/sandbox:latest
FROM ${BASE}
LABEL platform.tmux="true" \
      platform.supportedRuntimes="codex" \
      platform.resourceDefaults="{\"cores\":2,\"ramMb\":2048,\"diskMb\":10240}"
