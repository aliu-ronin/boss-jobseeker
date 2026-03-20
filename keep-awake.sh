#!/usr/bin/env bash
# keep-awake.sh - 防休眠脚本，配合 Boss 求职助手 Chrome 扩展使用
# 仅 macOS 有效，其他平台静默退出
# caffeinate -d 阻止显示器休眠，-w <pid> 绑定到 Chrome 进程

set -euo pipefail

# 平台检测
if [[ "$(uname)" != "Darwin" ]]; then
    echo "[keep-awake] 当前系统非 macOS，无需防休眠，退出。"
    exit 0
fi

# 幂等检测：已有 caffeinate 在运行则跳过
if pgrep -f "caffeinate -d" >/dev/null 2>&1; then
    echo "[keep-awake] caffeinate 已在运行 ($(pgrep -f 'caffeinate -d' | head -1))，无需重复启动。"
    exit 0
fi

CAFFEINATE_PID=""

cleanup() {
    echo ""
    if [[ -n "$CAFFEINATE_PID" ]] && kill -0 "$CAFFEINATE_PID" 2>/dev/null; then
        kill "$CAFFEINATE_PID" 2>/dev/null
        echo "[keep-awake] 已终止 caffeinate (PID: $CAFFEINATE_PID)"
    fi
    echo "[keep-awake] 防休眠已关闭，系统恢复正常休眠策略。"
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# 等待 Chrome 启动
echo "[keep-awake] 正在检测 Chrome 进程..."
while true; do
    CHROME_PID=$(pgrep -x "Google Chrome" 2>/dev/null | head -1 || true)
    if [[ -n "$CHROME_PID" ]]; then
        break
    fi
    echo "[keep-awake] Chrome 未运行，等待启动... (Ctrl+C 退出)"
    sleep 5
done

echo "[keep-awake] 检测到 Chrome (PID: $CHROME_PID)"

# 启动 caffeinate，绑定到 Chrome 进程
caffeinate -d -w "$CHROME_PID" &
CAFFEINATE_PID=$!

echo "[keep-awake] 防休眠已启动 (caffeinate PID: $CAFFEINATE_PID)"
echo "[keep-awake] 绑定到 Chrome PID: $CHROME_PID"
echo "[keep-awake] 按 Ctrl+C 手动停止，或关闭 Chrome 自动结束"
echo ""

# 监控循环
while true; do
    # 检查 Chrome 是否还在
    if ! kill -0 "$CHROME_PID" 2>/dev/null; then
        echo "[keep-awake] Chrome 已退出，自动清理..."
        break
    fi
    # 检查 caffeinate 是否还在（可能被外部 kill）
    if ! kill -0 "$CAFFEINATE_PID" 2>/dev/null; then
        echo "[keep-awake] caffeinate 进程已终止，退出监控。"
        CAFFEINATE_PID=""
        break
    fi
    sleep 30
done
