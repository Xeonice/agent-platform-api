# 平台预制**默认**镜像 = base + 预装全部内建 runtime CLI。
#
# ── 为什么要预装（04 §7 ★ 的 753 秒）─────────────────────────────────────────
# 上游镜像预装了 codex 但**没有 claude-code**，实测现装 **753 秒（12.5 分钟）**。
# 那 12.5 分钟今天发生在**每一个** claude-code Task 的「启动实例」格里。
# 预装把它挪到「发布一次」—— 同样的字节，付一次而不是每次。
#
# ⚠️ **现装兜底不因此移除**：自定义镜像可以只 FROM base 而不预装任何 runtime，
# 那时 install plan 现装仍然是唯一的路，而血统保证了 node 在 ⇒ 它一定装得上。
# 预装是快路径，不是唯一路径。
ARG BASE=localhost:5001/platform/base:v1
FROM ${BASE}
RUN npm install -g @anthropic-ai/claude-code \
 && claude --version
LABEL platform.supportedRuntimes="codex,claude-code"
