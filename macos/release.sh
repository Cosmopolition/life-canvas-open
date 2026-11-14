#!/usr/bin/env bash
# ============================================================
#  release.sh — 出可双击使用的 release 版，放到桌面
#
#  跟 build.sh 的区别：
#    build.sh    开发用：单架构、ad-hoc 签名、装在 macos/.build/
#    release.sh  给人用：universal 二进制、正式签名、装到桌面
#
#  用法：
#    ./macos/release.sh                     # → ~/Desktop/人生画布.app
#    ./macos/release.sh /path/to/dest.app   # 指定位置
#
#  可覆盖的环境变量：
#    LIFE_CANVAS_BUNDLE_ID   bundle id（默认 com.example.lifecanvas）
#    LIFE_CANVAS_SIGN_NAME   签名身份（默认 Apple Development）
#
#  这条管线的自检项：
#    · 必须是 **universal binary**（arm64 + x86_64）
#    · Info.plist 关键键要逐项自检（不是"看起来对"）
#    · app 根目录只允许有 Contents/
#    · 签名前清 quarantine
#    · 签名后 codesign --verify --deep --strict
#
#  ⚠️ **本地开发用 build.sh 就够了** —— 它是 ad-hoc 签名，不需要任何证书。
#    这个脚本是给"要给别人装"用的，需要你自己的开发证书。
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

APP_NAME="人生画布"
# bundle id 可以覆盖：换 id = 换沙盒容器 = **用户的数据会失联**（见
# macos/LifeCanvas/README.md 的「换 bundle id 怎么迁数据」）。
#
# ⚠️ 默认值跟 macos/LifeCanvas/Info.plist 里的 CFBundleIdentifier **必须一致**：
#    下面第 3 步会把 Info.plist 里的 id 改写成 $BUNDLE_ID，第 4.2 步再拿
#    改写后的值跟 $BUNDLE_ID 对账 —— 两边不一致会在自检那里被挡住。
#    公开仓用的是占位 id（com.example.lifecanvas）；发布成自己的产品时
#    把这两个地方一起改掉。
BUNDLE_ID="${LIFE_CANVAS_BUNDLE_ID:-com.example.lifecanvas}"
EXE="LifeCanvas"
MIN_OS="13.0"

# 签名身份：Apple Development —— 本机可跑且带沙盒 entitlement。
# ⚠️ 不要用 Apple Distribution：那种是给 Mac App Store 用的，
#    签出来的包在本机会被 AMFI 拦（"No matching profile found"）。
#
# ⚠️⚠️ **必须用 SHA-1 指纹，不能用证书名**：
#    钥匙串里可能有两张同名的 "Apple Development: <你的名字>"，
#    codesign 收到名字会直接报
#        "ambiguous (matches ... and ...)" → 签名失败 → app 根本没签名
#    （本项目 2026-10-23 实测踩到）。
#    → 默认从钥匙串里取 Apple Development 的指纹；也可用环境变量指定。
SIGN_NAME="${LIFE_CANVAS_SIGN_NAME:-Apple Development}"

DEST="${1:-$HOME/Desktop/$APP_NAME.app}"

echo "════════ 人生画布 · release build ════════"
echo "  目标位置：$DEST"
echo "  bundle id：$BUNDLE_ID"
echo

# ── 0. 清理：先退掉正在跑的实例，否则替换二进制会失败 ────────────
if pgrep -f "$EXE.app/Contents/MacOS/$EXE" >/dev/null 2>&1; then
  echo "▸ 退出正在运行的实例"
  pkill -f "$EXE.app/Contents/MacOS/$EXE" 2>/dev/null || true
  sleep 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/lifecanvas-release.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ── 1. 构建 web ────────────────────────────────────────────────
echo "▸ 1/7  构建 web（npm run build）"
npm run build --silent

# ── 2. universal 二进制 ────────────────────────────────────────
#
# ⚠️⚠️ 必须同时支持 Intel 和 Apple Silicon。
#    只出当前架构（这台机是 arm64）的话，Intel Mac 装上直接跑不起来。
#    （Mac App Store 也是硬性要求。）
#
# ⚠️ --show-bin-path 之类的"取产物路径"必须带一样的 --arch，
#    否则拿到的是另一个架构的旧产物 —— 改了参数却没生效，很难发现。
echo "▸ 2/7  编译 universal 二进制（arm64 + x86_64）"
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
for ARCH in arm64 x86_64; do
  echo "  · $ARCH"
  swiftc -O \
    -target "$ARCH-apple-macos$MIN_OS" \
    -framework Cocoa -framework WebKit \
    -o "$TMP/$EXE-$ARCH" \
    "${SRCS[@]}"
done
lipo -create "$TMP/$EXE-arm64" "$TMP/$EXE-x86_64" -output "$TMP/$EXE"

ARCH_LINE="$(lipo -info "$TMP/$EXE" 2>&1)"
if ! echo "$ARCH_LINE" | grep -q "x86_64" || ! echo "$ARCH_LINE" | grep -q "arm64"; then
  echo "  ❌ 只支持单一架构 —— Intel Mac 上跑不起来：$ARCH_LINE" >&2
  exit 1
fi
echo "  ✓ $ARCH_LINE"

# ── 3. 组装 .app ───────────────────────────────────────────────
#
# ⚠️⚠️ 暂存目录**不能以 .app 结尾**。
#    LaunchServices 会把任何一个完整的 .app 注册进去；临时目录删掉后
#    就留下一条**悬空注册**，还占着同一个 bundle id ——
#    Dock / 启动台会因此解析到系统通用占位图标而不是真图标。
#    （LifeCanvas 真实踩过：见 macos/Icon/README.md）
echo "▸ 3/7  组装 .app"
STAGE="$TMP/staging"
PAYLOAD="$STAGE/Contents"
mkdir -p "$PAYLOAD/MacOS" "$PAYLOAD/Resources"

cp "$TMP/$EXE"                 "$PAYLOAD/MacOS/$EXE"
cp -R "$ROOT/dist"             "$PAYLOAD/Resources/dist"
cp "$ROOT/macos/Icon/LifeCanvas.icns" "$PAYLOAD/Resources/LifeCanvas.icns"
cp "$ROOT/macos/LifeCanvas/Info.plist" "$PAYLOAD/Info.plist"

# ⚠️⚠️ bundle id 必须**写进** Info.plist，不能只活在环境变量里。
#    源码里的 Info.plist 带的是默认 id；用 LIFE_CANVAS_BUNDLE_ID 覆盖时
#    如果不回写文件，第 4.2 步的自检就会拿 plist 里的旧 id 跟 $BUNDLE_ID
#    对账 → 判定「bundle id 不对」→ release.sh 直接退出。
#    ⇒ 覆盖能力等于没有（实测：环境变量一覆盖就被卡住）。
#
#    用 perl -0777 做**文本**替换，不用 PlistBuddy / plutil：
#    那两个都会重写整个 plist，把 Info.plist 里的中文注释（localization
#    那段解释）全部丢掉 —— 替换完只剩 0 条注释。文本替换只动那一行。
LC_BUNDLE_ID="$BUNDLE_ID" perl -0777 -i -pe \
  's{(<key>CFBundleIdentifier</key>\s*<string>)[^<]*(</string>)}{$1 . $ENV{LC_BUNDLE_ID} . $2}e' \
  "$PAYLOAD/Info.plist"

# 回写没生效（比如以后有人改了 Info.plist 的键名）要当场报错，
# 不能拖到第 4.2 步才用一个笼统的「bundle id 不对」把人引到别处去。
PLIST_ID_NOW="$(plutil -extract CFBundleIdentifier raw "$PAYLOAD/Info.plist" 2>/dev/null || echo '')"
if [ "$PLIST_ID_NOW" != "$BUNDLE_ID" ]; then
  echo "  ❌ bundle id 回写失败：Info.plist 里是「${PLIST_ID_NOW:-<读不出来>}」，应为「$BUNDLE_ID」" >&2
  echo "     检查 macos/LifeCanvas/Info.plist 里 CFBundleIdentifier 这个键还在不在" >&2
  exit 1
fi
echo "  ✓ bundle id 已写入 Info.plist：$PLIST_ID_NOW"

# ⚠️⚠️ **entitlements 文件不能放进 app bundle 里**
#    codesign 会把 bundle 内每个文件都当成"子组件"要求它有签名，
#    而 plist 签不了 → 整个签名直接失败：
#        "In subcomponent: .../Contents/LifeCanvas.entitlements
#         code object is not signed at all"
#    （本项目 2026-10-23 实测踩到；错误被 || true 吞掉时，
#      表现是"看起来签了，其实没有"）
#    → entitlements 只在签名时从源码路径读，不进 bundle。

# 名称本地化：Info.plist 里的值只是兜底，真正生效的是各语言的 InfoPlist.strings。
# 少了它，英文系统的 Finder / 菜单里显示的就是中文名。
mkdir -p "$PAYLOAD/Resources/zh-Hans.lproj" "$PAYLOAD/Resources/en.lproj"
cat > "$PAYLOAD/Resources/zh-Hans.lproj/InfoPlist.strings" <<'STRINGS'
"CFBundleName" = "人生画布";
"CFBundleDisplayName" = "人生画布";
STRINGS
cat > "$PAYLOAD/Resources/en.lproj/InfoPlist.strings" <<'STRINGS'
"CFBundleName" = "Life Canvas";
"CFBundleDisplayName" = "Life Canvas";
STRINGS

# ── 4. 自检 ────────────────────────────────────────────────────
#
# ⚠️ 这些检查不能省：bundle 里的错不会在构建期报错，
#    而是等到用户双击那一刻才崩（或者更糟：静默用错配置）。
echo "▸ 4/7  自检"

# 4.1 Info.plist 格式合法 —— XML 注释里写两个连字符就会把注释提前截断，
#     后面的文字变成正文 → plutil 读不出来 → App 启动即崩，且没有任何日志线索。
if ! plutil -lint "$PAYLOAD/Info.plist" >/dev/null 2>&1; then
  echo "  ❌ Info.plist 格式非法 —— App 会启动即崩" >&2
  plutil -lint "$PAYLOAD/Info.plist" 2>&1 | sed 's/^/     /' >&2
  exit 1
fi

# 4.2 关键键齐全 + bundle id 对得上
if ! plutil -convert json -o - "$PAYLOAD/Info.plist" 2>/dev/null \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
need = ['CFBundleIdentifier','CFBundleExecutable','CFBundleName','CFBundleVersion',
        'CFBundleShortVersionString','CFBundleIconFile','LSApplicationCategoryType',
        'NSHighResolutionCapable','NSPrincipalClass']
miss = [k for k in need if not d.get(k)]
if miss:
    print('缺关键键: ' + ','.join(miss)); sys.exit(1)
if d.get('CFBundleIdentifier') != '$BUNDLE_ID':
    print('bundle id 不对: ' + str(d.get('CFBundleIdentifier'))); sys.exit(1)
if d.get('CFBundleIconFile') != 'LifeCanvas.icns':
    print('图标名不对: ' + str(d.get('CFBundleIconFile'))); sys.exit(1)
cat = d.get('LSApplicationCategoryType')
if not cat.startswith('public.app-category.'):
    print('分类 UTI 不合法: ' + str(cat)); sys.exit(1)
print('版本 ' + str(d.get('CFBundleShortVersionString')) + ' (' + str(d.get('CFBundleVersion')) + ')')
" 2>/dev/null; then
  echo "  ❌ Info.plist 缺关键键或 bundle id 不对 —— App 起不来" >&2
  exit 1
fi
echo "  ✓ Info.plist 合法，关键键齐全"

# 4.3 图标必须在包里且非空 —— 少了它 Dock 里就是通用占位图
if [ ! -s "$PAYLOAD/Resources/LifeCanvas.icns" ]; then
  echo "  ❌ 缺 LifeCanvas.icns —— Dock 会显示通用占位图" >&2
  exit 1
fi
echo "  ✓ 图标在包里（$(stat -f%z "$PAYLOAD/Resources/LifeCanvas.icns") bytes）"

# 4.4 dist 必须在包里 —— 少了它白屏
if [ ! -s "$PAYLOAD/Resources/dist/index.html" ]; then
  echo "  ❌ 缺 dist/index.html —— 启动白屏" >&2
  exit 1
fi
echo "  ✓ web 产物在包里"

# 4.5 app 根目录只允许有 Contents/ —— 多一个文件 codesign 直接拒
ROOT_EXTRA="$(ls -A "$STAGE" | grep -v '^Contents$' || true)"
if [ -n "$ROOT_EXTRA" ]; then
  echo "  ❌ app 根目录有多余内容（codesign 会拒）：$ROOT_EXTRA" >&2
  exit 1
fi

# 4.6 清 quarantine（下载隔离标记）—— App Store 明令禁止 app 里带这个属性
xattr -r -d com.apple.quarantine "$STAGE" 2>/dev/null || true
N_Q=$(xattr -r "$STAGE" 2>/dev/null | grep -ci quarantine || true)
if [ "${N_Q:-0}" != "0" ]; then
  echo "  ❌ 还有 $N_Q 个文件带 quarantine" >&2
  exit 1
fi
echo "  ✓ 无 quarantine 标记"

# ── 5. 签名 ────────────────────────────────────────────────────
#
# ⚠️ 三层签名，缺一不可：可执行文件 → 资源 → 整个 .app
# ⚠️ 沙盒 entitlement 必须在签名时带上（Mac App Store 硬性要求）
echo "▸ 5/7  签名（Apple Development + 沙盒 + hardened runtime）"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
ditto "$STAGE" "$DEST"

SIGN_IDENTITY=""
SIGN_LABEL=""
# 逐个候选试：同名证书有歧义，用指纹才唯一
CANDIDATES="${LIFE_CANVAS_IDENTITY:-}"
if [ -z "$CANDIDATES" ]; then
  CANDIDATES=$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -F "$SIGN_NAME" | awk '{print $2}')
fi
for SHA in $CANDIDATES; do
  if codesign --force --sign "$SHA" \
      --entitlements "$ROOT/macos/LifeCanvas/LifeCanvas.entitlements" \
      --options runtime --timestamp \
      "$DEST" >/dev/null 2>&1; then
    SIGN_IDENTITY="$SHA"
    SIGN_LABEL="$(security find-identity -v -p codesigning 2>/dev/null \
      | grep -F "$SHA" | sed 's/.*"\(.*\)"/\1/')"
    break
  fi
done
if [ -z "$SIGN_IDENTITY" ]; then
  echo "  ⚠️ 没有可用的开发签名（${SIGN_NAME}），退回 ad-hoc："
  echo "     本机可跑，但 Gatekeeper 会对「来自互联网」的提示更敏感"
  codesign --force --sign - \
    --entitlements "$ROOT/macos/LifeCanvas/LifeCanvas.entitlements" \
    "$DEST" >/dev/null 2>&1 || true
  SIGN_LABEL="ad-hoc"
fi

# 签名后必须验一遍 —— 签失败还照样打包出去，等于交付一个打不开的 app
if ! codesign --verify --deep --strict "$DEST" 2>&1; then
  echo "  ❌ 签名校验不过" >&2
  exit 1
fi
ENTITLEMENTS_OK="$(codesign -d --entitlements - "$DEST" 2>/dev/null | grep -c "app-sandbox" || true)"
echo "  ✓ 签名有效：${SIGN_LABEL:-ad-hoc}（${SIGN_IDENTITY:0:8}…）"
echo "  ✓ 沙盒 entitlement ${ENTITLEMENTS_OK} 项"

# ── 6. 装到桌面并注册 ──────────────────────────────────────────
echo "▸ 6/7  安装到 $DEST"

# 注册到 LaunchServices，让 Dock / 启动台立刻认得（否则显示通用占位图）
LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSR" -f "$DEST" 2>/dev/null || true
# 旧的 bundle id（com.lifecanvas.app）注销掉，避免同一个 app 出现两份
"$LSR" -u "$ROOT/macos/.build/LifeCanvas.app" 2>/dev/null || true
killall Dock 2>/dev/null || true

# ── 7. 最终验收 ────────────────────────────────────────────────
echo "▸ 7/7  验收"
[ -x "$DEST/Contents/MacOS/$EXE" ] || { echo "  ❌ 可执行文件没落地" >&2; exit 1; }
[ -s "$DEST/Contents/Resources/LifeCanvas.icns" ] || { echo "  ❌ 图标没落地" >&2; exit 1; }
[ -s "$DEST/Contents/Resources/dist/index.html" ] || { echo "  ❌ web 产物没落地" >&2; exit 1; }
plutil -lint "$DEST/Contents/Info.plist" >/dev/null

echo
echo "════════ 完成 ════════"
echo "  app：   $DEST"
echo "  版本：  $(plutil -extract CFBundleShortVersionString raw "$DEST/Contents/Info.plist") ($(plutil -extract CFBundleVersion raw "$DEST/Contents/Info.plist"))"
echo "  id：    $(plutil -extract CFBundleIdentifier raw "$DEST/Contents/Info.plist")"
echo "  架构：  $(lipo -info "$DEST/Contents/MacOS/$EXE" 2>&1 | sed 's/.*: //')"
echo "  签名：  ${SIGN_LABEL:-ad-hoc}"
echo "  启动：  open \"$DEST\""
