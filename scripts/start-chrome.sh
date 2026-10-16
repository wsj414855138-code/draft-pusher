#!/usr/bin/env bash
# start-chrome.sh — 启动一个独立的「调试用 Chrome」，供 CDP 自动化驱动
#
# 为什么需要一个独立的 Chrome 实例：
#   1. 不污染你日常浏览器的 profile（独立 user-data-dir）
#   2. 固定调试端口，所有脚本默认连 9223（CDP_PORT 可覆盖）
#   3. 首次启动后，在这个窗口里登录公众号后台 / 小红书创作平台，
#      登录态会保存在 profile 目录里，之后免登录
#
# 用法：
#   ./start-chrome.sh                 # 前台启动（关掉终端窗口即退出）
#   CDP_PORT=9333 ./start-chrome.sh   # 换端口
#
# 想让它常驻后台：
#   nohup ./start-chrome.sh >/dev/null 2>&1 &
#
# 说明：
#   --no-sandbox --disable-gpu 是为了让 Chrome 在受限环境（沙箱 / 部分
#   自动化环境）里也能正常启动；普通桌面环境下可以去掉这两个参数。
#   ⚠️ 这个实例自带调试端口，能读取登录态 —— 只在自己电脑上本地运行，
#   不要把它暴露到公网。

set -euo pipefail

PORT="${CDP_PORT:-9223}"
PROFILE="${CDP_PROFILE:-$HOME/.draft-pusher/chrome-profile}"

if [[ -n "${CHROME_PATH:-}" ]]; then
  CHROME="$CHROME_PATH"
elif [[ "$(uname -s)" == "Darwin" ]]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
  CHROME="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true)"
fi

if [[ -z "${CHROME:-}" || ! -x "$CHROME" ]]; then
  echo "❌ 找不到 Chrome。请用 CHROME_PATH=/path/to/chrome 指定可执行文件路径" >&2
  exit 1
fi

mkdir -p "$PROFILE"

echo "▶ 调试 Chrome"
echo "   可执行文件：$CHROME"
echo "   调试端口：$PORT"
echo "   profile：$PROFILE"
echo ""
echo "   首次使用请在这个窗口里登录："
echo "     · 公众号后台   https://mp.weixin.qq.com"
echo "     · 小红书创作台 https://creator.xiaohongshu.com"
echo ""

exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  '--remote-allow-origins=*' \
  --user-data-dir="$PROFILE" \
  --no-sandbox --disable-gpu \
  --no-first-run --no-default-browser-check \
  --window-size=1512,950 \
  "https://mp.weixin.qq.com/"
