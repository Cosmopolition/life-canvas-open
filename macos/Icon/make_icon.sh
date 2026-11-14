#!/usr/bin/env bash
# make_icon.sh — 从 AI 源图一步出到可用的 .icns
#
#   源图(AI 出的 2048 稿) ──compose_icon.py──> 1024 master ──make_iconset.py+iconutil──> .icns
#
# 为什么要中间这一层：图像模型会把「透明背景」画成棋盘格烤进像素，
# 轮廓也是 iOS 风格的大圆角。compose_icon.py 负责抠像 + 套回精确的
# macOS squircle（1024 画布 / 824 主体 / 100 边距 / n=5 超椭圆）。
#
# 用法：
#   ./make_icon.sh                       # 用默认源图重建
#   ./make_icon.sh <源图> [输出.icns]
#
# ⚠️ 依赖 Pillow（compose_icon.py / make_iconset.py 都要它）：
#       pip3 install -r requirements.txt
#    没装的话第 1 步就会 ModuleNotFoundError: No module named 'PIL'。
set -euo pipefail

cd "$(dirname "$0")"

SRC="${1:-source/ai-H-threads.png}"
OUT="${2:-LifeCanvas.icns}"
MASTER="preview/master-1024.png"
ICONSET=".build/LifeCanvas.iconset"

if [[ ! -f "$SRC" ]]; then
  cat >&2 <<EOF
找不到源图：$SRC

公开仓**没有**随附这张 AI 源图（成品的「H · 主线」那张稿是图像模型出的，
源图和提示词都留在了私有源仓里，没进公开仓）。所以直接跑 ./make_icon.sh
默认是跑不通的 —— 这不是脚本坏了，是素材没跟着进仓。

现在有两条路：

  A) 矢量路线（仓库自带，可完整复现，不需要任何外部素材）
       swift icon.swift 2 preview/master-1024.png 1024
       python3 make_iconset.py preview/master-1024.png .build/LifeCanvas.iconset
       iconutil -c icns .build/LifeCanvas.iconset -o LifeCanvas.icns
     ⚠️ icon.swift 目前只能出概念稿 A/B/C/D（1=星图 2=阶段框 3=卡片 4=混合），
        **出不来成品那张「H · 主线」** —— 那张只存在于上面说的 AI 源图里。

  B) AI 路线（自带一张 2048 源图）
       ./make_icon.sh <你的源图.png>
     合成脚本跟成品的管线是同一条（抠棋盘格 + 套精确 squircle），
     但你换的稿子，出来的图标自然也跟成品不一样。
EOF
  exit 1
fi

echo "==> 1/3  合成 master（抠棋盘格 + 套精确 macOS squircle）"
python3 compose_icon.py "$SRC" "$MASTER" 1024

echo "==> 2/3  生成 .iconset"
rm -rf "$ICONSET"
python3 make_iconset.py "$MASTER" "$ICONSET"

echo "==> 3/3  iconutil 打包 .icns"
iconutil -c icns "$ICONSET" -o "$OUT"

rm -rf "$ICONSET"

echo
echo "完成：$OUT"
echo "  master：$MASTER"
