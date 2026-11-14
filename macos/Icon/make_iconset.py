#!/usr/bin/env python3
"""
make_iconset.py — 由 1024 master 生成 macOS 要求的 .iconset 目录。

用 PIL 的 LANCZOS 缩放（sips 的重采样质量一般，图标边缘会被打毛）。

用法: make_iconset.py <master.png> <out.iconset>
"""

import sys
import os
from PIL import Image

# macOS .iconset 需要的全部尺寸
SPEC = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]


def main(master, outdir):
    im = Image.open(master).convert("RGBA")
    if im.size != (1024, 1024):
        raise SystemExit(f"master 必须是 1024x1024，实际 {im.size}")
    os.makedirs(outdir, exist_ok=True)
    for name, px in SPEC:
        im.resize((px, px), Image.LANCZOS).save(os.path.join(outdir, name))
    print(f"iconset -> {outdir} ({len(SPEC)} files)")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("用法: make_iconset.py <master.png> <out.iconset>")
    main(sys.argv[1], sys.argv[2])
