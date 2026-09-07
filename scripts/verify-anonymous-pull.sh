#!/usr/bin/env bash
# 验证一张已发布的镜像**匿名拉得到** —— 发布镜像的全部意义就是「新部署拿得到」。
#
# ── 它为什么是一个独立脚本，而不是 workflow 里的五行 curl ──────────────────────
# ⛔ 第一版就是那五行，而它**从没绿过**：`Accept` 头只声明了 docker 的
#    `manifest.list.v2+json`，而双架构 buildx 推的是 **OCI image index**
#    （`application/vnd.oci.image.index.v1+json`）。GHCR 在媒体类型不匹配时回 **404**，
#    于是这一步在镜像明明已经 public、双架构齐全的情况下判失败，
#    还打出「去 GitHub Packages 把包设为 public」—— **把人指向了一件根本不用做的事**。
#
# ⚠️ 一道**只在 40 分钟构建之后才跑得到**的检查，改完没法验证就等于没改。抽成脚本之后
#    它可以拿任意一张真实已发布镜像在本地跑，这份逻辑因此是**验过的**，不是写完就发的。
#
# 用法：verify-anonymous-pull.sh <owner> <image> <tag> [<tag>...]
set -euo pipefail

OWNER="${1:?owner}"; IMAGE="${2:?image}"; shift 2
TAGS=("$@"); [ ${#TAGS[@]} -eq 0 ] && TAGS=(latest)

# ⚠️ 两套媒体类型都要声明：OCI index（buildx 多架构的默认产物）与 docker manifest list
#    （单架构或旧 buildx）。少声明哪一套，那一套就会被 registry 当作「没有」。
ACCEPT='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
WANT_PLATFORMS=('linux/amd64' 'linux/arm64')

fail=0
# ⚠️ **用匿名 token**（不带任何凭证换来的那个），而不是 job 里已登录的凭证 —— 这一步问的
#    正是「一个谁也不是的新用户拉不拉得到」。用登录态验证会永远是绿的。
# ⚠️ **`|| true` 不能省**：`set -e` + `pipefail` 下，curl 一失败脚本就当场死掉 ——
#    死在这一行意味着**下面那条说得出下一步的提示根本不会被打出来**，用户只看到一个
#    没有任何输出的非零退出。一个「失败了却不说为什么」的检查，比没有检查更难查。
TOKEN=$(curl -sf "https://ghcr.io/token?scope=repository:${OWNER}/${IMAGE}:pull&service=ghcr.io" \
  | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)
if [ -z "$TOKEN" ]; then
  echo "::error title=匿名 token 拿不到::ghcr.io/token 没有给 ${OWNER}/${IMAGE} 发匿名 token —— 包多半是 private。"
  exit 1
fi

for tag in "${TAGS[@]}"; do
  REF="ghcr.io/${OWNER}/${IMAGE}:${tag}"
  body=$(mktemp)
  code=$(curl -s -o "$body" -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" -H "Accept: ${ACCEPT}" \
    "https://ghcr.io/v2/${OWNER}/${IMAGE}/manifests/${tag}")

  if [ "$code" != "200" ]; then
    # ⚠️ **不替 registry 断言原因**。第一版就是断言了「一定是没设 public」，
    #    而真因是 Accept 头 —— 一条自信的错误提示，比没有提示更能让人跑偏。
    case "$code" in
      401|403) why="包不是 public，或匿名身份没有 pull 权限" ;;
      404)     why="这个 tag 不存在，或它的媒体类型不在本脚本声明的 Accept 里" ;;
      *)       why="未预期的状态码" ;;
    esac
    echo "::error title=匿名拉不到 ${REF}::HTTP ${code} —— ${why}。新部署会拿不到这张镜像。"
    sed -n '1,5p' "$body" | sed 's/^/    /'
    fail=1; rm -f "$body"; continue
  fi

  # ⛔ 200 还不够：**要确认两个架构都在**。只出一份会让另一半宿主在
  #    `provider.create()` 时才发现架构不对 —— 运行期失败，比构建期晚得多。
  #    而 Apple Silicon 恰恰是 boxlite 档的主力宿主。
  # ⚠️ 冒号后**可能有空格**：GHCR 回的是格式化过的 JSON（`"architecture": "amd64"`），
  #    而紧挨着的写法只匹配得到压缩 JSON。第一版就漏了这个空格 —— 于是一张双架构齐全的
  #    镜像被判成「一个架构都没有」。⇒ `[[:space:]]*` 两侧都要留。
  got=$(tr ',' '\n' < "$body" \
    | sed -n 's/.*"architecture"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | sort -u | tr '\n' ' ')
  missing=''
  for want in "${WANT_PLATFORMS[@]}"; do
    arch="${want#linux/}"
    case " $got " in *" $arch "*) ;; *) missing="$missing $want" ;; esac
  done
  if [ -n "$missing" ]; then
    echo "::error title=架构不全 ${REF}::缺${missing} —— 那一半宿主要到建任务时才发现拉到的镜像跑不了。"
    echo "    实际架构: ${got:-（一个都没解析出来，可能不是多架构 index）}"
    fail=1
  else
    echo "✅ 匿名可拉取：${REF}（${got%% }）"
  fi
  rm -f "$body"
done

exit $fail
