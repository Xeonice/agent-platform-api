#!/bin/sh
# 后端无法启动时也能运行；不加载编译产物、不连接平台 API。
set -eu
cd "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
exec node scripts/diagnose.mjs "$@"
