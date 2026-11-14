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
set -euo pipefail

cd "$(dirname "$0")"

SRC="${1:-source/ai-H-threads.png}"
OUT="${2:-LifeCanvas.icns}"
MASTER="preview/master-1024.png"
ICONSET=".build/LifeCanvas.iconset"

if [[ ! -f "$SRC" ]]; then
  echo "找不到源图：$SRC" >&2
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
