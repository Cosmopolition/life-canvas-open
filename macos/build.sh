#!/usr/bin/env bash
# build.sh — 用 swiftc 拼出 LifeCanvas.app
# 不依赖 xcodegen / tuist / 任何 .xcodeproj。
#
# 刻意不含任何删除步骤：每次在 mktemp -d 的暂存区里全新组装，再用 ditto
# 覆盖进 macos/.build/LifeCanvas.app。代价是 bundle 里可能残留上一次构建的
# 旧文件（dist 的资源名带内容 hash，几 KB），换来的是这个脚本不会碰掉任何
# 不属于它的东西。

set -euo pipefail

cd "$(dirname "$0")/.."   # 项目根
ROOT="$(pwd)"

BUILD="$ROOT/macos/.build"
APP="$BUILD/LifeCanvas.app"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/lifecanvas-build.XXXXXX")"
# 暂存区**不能**叫 *.app：LaunchServices 会把任何一个完整的 .app 注册进去，
# 临时目录删掉后就留下一条悬空注册（还占着同一个 bundle id），
# Dock / 启动台 会因此解析到通用占位图标而不是真图标。
# 所以这里拼的是一个无扩展名的普通目录，最后才ditto 成 LifeCanvas.app。
PAYLOAD="$STAGE/staging/Contents"
MACOS_DIR="$PAYLOAD/MacOS"
RES_DIR="$PAYLOAD/Resources"

mkdir -p "$BUILD" "$MACOS_DIR" "$RES_DIR"

echo "==> 1/5  构建 web（npm run build）"
npm run build --silent

echo "==> 2/5  组装 .app 骨架（暂存区 ${STAGE}）"
cp "$ROOT/macos/LifeCanvas/Info.plist"            "$PAYLOAD/Info.plist"
# ⚠️ entitlements 文件**不要放进 bundle** —— codesign 会把 bundle 内每个文件
#    都当成子组件要求签名，plist 签不了 → 整个签名失败。
#    签名时从源码路径读即可（见下方 codesign --entitlements）。
cp "$ROOT/macos/Icon/LifeCanvas.icns"             "$RES_DIR/LifeCanvas.icns"
cp -R "$ROOT/dist" "$RES_DIR/dist"

echo "==> 3/5  swiftc 编译"
SRCS=(
  "$ROOT/macos/LifeCanvas/main.swift"
  "$ROOT/macos/LifeCanvas/AppDelegate.swift"
  "$ROOT/macos/LifeCanvas/MainWindowController.swift"
  "$ROOT/macos/LifeCanvas/Bridge.swift"
  "$ROOT/macos/LifeCanvas/L10n.swift"
  "$ROOT/macos/LifeCanvas/SchemeHandler.swift"
  "$ROOT/macos/LifeCanvas/SelfTest.swift"
  "$ROOT/macos/LifeCanvas/WindowShot.swift"
)
swiftc -O \
  -target arm64-apple-macos13.0 \
  -framework Cocoa -framework WebKit \
  -o "$MACOS_DIR/LifeCanvas" \
  "${SRCS[@]}"

echo "==> 4/5  覆盖进 $APP"
# ⚠️ 先清掉 bundle 里**上一次**的 dist。
#    ditto 是**合并**不是替换 —— dist 的资源名带内容 hash，
#    每构建一次就多留一份（实测 80 次构建后 bundle 里堆了 17M 旧资源，
#    而当前构建实际只有 364K）。
#    这里只删 bundle 里那一个 dist 目录 —— 它整个就是从 $ROOT/dist 拷来的、
#    全是脚本自己的产物，不涉及 bundle 里任何别的东西
#    （跟下面删遗留 entitlements 是同一个思路）。
rm -rf "$APP/Contents/Resources/dist"
ditto "$STAGE/staging" "$APP"

# ⚠️ 清掉一个**历史上遗留**的文件。
#    早期版本把 entitlements 复制进 bundle，codesign 会把它当子组件要求签名
#    （plist 签不了 → "In subcomponent: ... code object is not signed at all"）。
#    现在 entitlements 只在签名时从源码路径读，bundle 里不该再有它 ——
#    但这个脚本刻意不做整体删除（不碰不属于它的东西），所以旧文件会留下来。
#    → 这里只精确删这一个已知文件。
rm -f "$APP/Contents/LifeCanvas.entitlements"

echo "==> 5/5  ad-hoc 签名（本地跑足够；上架需换成 Developer ID）"
codesign --force --deep --sign - \
  --entitlements "$ROOT/macos/LifeCanvas/LifeCanvas.entitlements" \
  "$APP" 2>/dev/null || true

# ── 开发用裸二进制（未签名） ─────────────────────────────────────────────
# 为什么要另出一个：打包好的 .app 带 App Sandbox，**读不到容器外**的路径。
# 所以 `LIFECANVAS_DIST=~/项目/dist` 配 .app 跑，SchemeHandler 取不到文件 →
# 导航 -1100 → 页面停在 about:blank → 看起来像"app 坏了"。
# 未签名的二进制没有沙盒，才能读到外面的 dist —— 热更必须用它。
#
# ⚠️ 它和 .app 读的是**两个不同的库**（沙盒内外 IndexedDB 各存各的），
#    别拿这个构建里加的点去跟 .app 里对账。
cp "$MACOS_DIR/LifeCanvas" "$BUILD/LifeCanvas-dev"
chmod +x "$BUILD/LifeCanvas-dev"

echo
echo "完成：$APP"
echo "  启动：  open \"${APP}\""
echo "  自测：  \"$APP/Contents/MacOS/LifeCanvas\" --selftest"
echo "  免打包热更（改完 dist 直接跑，用**未签名**的那个二进制）："
echo "    LIFECANVAS_DIST=\"$ROOT/dist\" \"$BUILD/LifeCanvas-dev\""