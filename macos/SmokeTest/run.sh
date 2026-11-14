#!/bin/bash
#
# 编译并运行 go/no-go 冒烟测试。
#
#   ./macos/SmokeTest/run.sh
#
# 输出两行：SHALLOW|{...} 和 DEEP|{...}
#
# 判定：indexedDB / crypto.subtle / Worker 三项都要 true，
#       且 isSecureContext 必须为 true（否则 subtle 拿不到）。
#
# 这是一次性探针，不是可分发 app：不做 .app bundle 打包，
# scheme handler 直接读项目里的 dist/。零拷贝，零删除。
#
set -euo pipefail

cd "$(dirname "$0")/../.."   # 项目根

BIN="macos/.build/smoke"

echo "==> 1/4 构建 web（npm run build）"
npm run build --silent

echo "==> 2/4 swiftc 编译"
mkdir -p macos/.build
swiftc \
  -target arm64-apple-macos13.0 \
  -framework Cocoa -framework WebKit \
  -o "$BIN" \
  macos/SmokeTest/main.swift

echo "==> 3/4 phase 1（boot 真应用 + 写持久化标记）"
echo "---"
"$BIN" dist 1

echo
echo "==> 4/4 phase 2（重启，读回标记）"
echo "---"
"$BIN" dist 2

# 附：main.swift 第 4 个参数可传一个真实 URL，让页面不走 app:// 而走该 origin。
# 用于 A/B 对照 worker 在自定义 scheme 下的行为；需要自备本地静态服务，
# 所以默认不在这里跑。