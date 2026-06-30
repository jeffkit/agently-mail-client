#!/usr/bin/env bash
# 一键把本地最新代码发布到 launchd 上运行。
#
# 做三件事：
#   1. 重新构建 dashboard SPA（输出到 src/dashboard-dist/）
#   2. 重启 bridge 与 dashboard 两个 launchd 服务（kickstart -k）
#   3. 验证服务状态 + dashboard HTTP 可达
#
# 用法：
#   ./scripts/deploy-launchd.sh             # 构建 + 重启 + 验证
#   ./scripts/deploy-launchd.sh --no-build  # 跳过 dashboard 构建，只重启
#   SKIP_BUILD=1 ./scripts/deploy-launchd.sh
#
# 可通过环境变量覆盖默认值（默认值与 ~/Library/LaunchAgents 中的 plist 对齐）：
#   BRIDGE_LABEL   默认 com.jeffkit.agently-mail-client
#   DASH_LABEL     默认 com.jeffkit.agently-mail-client.dashboard

set -euo pipefail

# ── 配置 ────────────────────────────────────────────────────────────────────
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIDGE_LABEL="${BRIDGE_LABEL:-com.jeffkit.agently-mail-client}"
DASH_LABEL="${DASH_LABEL:-com.jeffkit.agently-mail-client.dashboard}"
DASH_URL="${DASH_URL:-http://127.0.0.1:3030/}"
BRIDGE_LOG="${BRIDGE_LOG:-/tmp/agently-mail-bridge.log}"
DASH_LOG="${DASH_LOG:-/tmp/agently-mail-dashboard.log}"

# ── 参数解析 ─────────────────────────────────────────────────────────────────
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done
[ "${SKIP_BUILD:-0}" = "1" ] && DO_BUILD=0

# ── 前置检查 ─────────────────────────────────────────────────────────────────
UID_NUM="$(id -u)"
GUI_DOMAIN="gui/$UID_NUM"

label_exists() { launchctl list "$1" >/dev/null 2>&1; }

echo "==> 检查 launchd 服务定义"
for lbl in "$BRIDGE_LABEL" "$DASH_LABEL"; do
  if ! label_exists "$lbl"; then
    echo "  ✗ 服务未加载: $lbl"
    echo "    先加载: launchctl load ~/Library/LaunchAgents/$(echo "$lbl" | tr '.' '/').plist"
    echo "    或检查 ~/Library/LaunchAgents/ 下对应 plist 是否存在"
    exit 1
  fi
  echo "  ✓ $lbl"
done

# ── 1. 构建 dashboard SPA ────────────────────────────────────────────────────
if [ "$DO_BUILD" -eq 1 ]; then
  echo "==> 构建 dashboard SPA (pnpm build)"
  cd "$ROOT_DIR/dashboard"
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "  ✗ 未找到 pnpm，请先安装 (corepack enable pnpm)" >&2
    exit 1
  fi
  pnpm build
  echo "  ✓ 构建完成 → $ROOT_DIR/src/dashboard-dist/"
else
  echo "==> 跳过 dashboard 构建（--no-build）"
fi

# ── 2. 重启 launchd 服务 ─────────────────────────────────────────────────────
echo "==> 重启 launchd 服务"
launchctl kickstart -k "$GUI_DOMAIN/$BRIDGE_LABEL"
echo "  ✓ bridge 已重启: $BRIDGE_LABEL"
launchctl kickstart -k "$GUI_DOMAIN/$DASH_LABEL"
echo "  ✓ dashboard 已重启: $DASH_LABEL"

# ── 3. 验证 ─────────────────────────────────────────────────────────────────
echo "==> 验证服务状态"
sleep 5

print_pid() {
  # launchctl list（无参数）输出表格: PID\tStatus\tLabel
  launchctl list 2>/dev/null | awk -v label="$1" '$3 == label {print $1}'
}

BRIDGE_PID="$(print_pid "$BRIDGE_LABEL")"
DASH_PID="$(print_pid "$DASH_LABEL")"
echo "  bridge    PID: $BRIDGE_PID"
echo "  dashboard PID: $DASH_PID"

# 等待 dashboard HTTP 起来（最多 ~20s）
http_ok=0
for _ in $(seq 1 10); do
  if curl -fsS -o /dev/null "$DASH_URL" 2>/dev/null; then http_ok=1; break; fi
  sleep 2
done
if [ "$http_ok" -eq 1 ]; then
  echo "  ✓ dashboard HTTP 可达: $DASH_URL"
else
  echo "  ✗ dashboard HTTP 不可达: $DASH_URL（可能仍在启动，查看日志: $DASH_LOG）" >&2
fi

echo
echo "==> 完成。最近日志："
echo "    bridge    : $BRIDGE_LOG"
echo "    dashboard : $DASH_LOG"
echo "    实时跟踪  : tail -f $BRIDGE_LOG $DASH_LOG"
