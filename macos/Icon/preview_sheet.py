#!/usr/bin/env python3
"""
preview_sheet.py — 把若干图标概念排成一张对比图（含真实尺寸的缩小预览）。

用法: preview_sheet.py <out.png> <concept.png> [concept.png ...]
"""

import sys
import os
from PIL import Image, ImageDraw, ImageFont

LABELS = {
    "A": "A · Constellation",
    "B": "B · Stage Frame",
    "C": "C · Hybrid",
    "D": "D · Cards",
    "E": "E · Slice",
    "F": "F · Stage Band",
    "G": "G · Lattice",
    "H": "H · Thread  (chosen)",
}


def load_font(size):
    cands = [
        ("/System/Library/Fonts/PingFang.ttc", 0),
        ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
        ("/System/Library/Fonts/STHeiti Medium.ttc", 0),
        ("/System/Library/Fonts/Helvetica.ttc", 0),
    ]
    for path, idx in cands:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=idx)
            except Exception:
                continue
    return ImageFont.load_default()


def main(out, paths):
    sizes = [16, 32, 64, 128]
    f_title = load_font(22)
    f_small = load_font(14)
    f_note = load_font(15)

    cell_w, cell_h = 300, 300
    pad = 34
    W = pad + len(paths) * (cell_w + 26)
    H = 560
    sheet = Image.new("RGB", (W, H), "#22252c")
    d = ImageDraw.Draw(sheet)

    x = pad
    for p in paths:
        key = os.path.basename(p).split("-")[0].upper()[:1]
        im = Image.open(p).convert("RGBA")

        card = Image.new("RGBA", (cell_w, cell_h), (247, 247, 250, 255))
        card.alpha_composite(im.resize((258, 258), Image.LANCZOS), (21, 21))
        sheet.paste(card.convert("RGB"), (x, 62))
        d.text((x, 28), LABELS.get(key, key), fill="#e8eaf0", font=f_title)

        bx = x + 8
        for s in sizes:
            strip = Image.new("RGBA", (s + 10, s + 10), (247, 247, 250, 255))
            strip.alpha_composite(im.resize((s, s), Image.LANCZOS), (5, 5))
            sheet.paste(strip.convert("RGB"), (bx, 396))
            bx += s + 16
        bx = x + 8
        for s in sizes:
            strip = Image.new("RGBA", (s + 10, s + 10), (38, 41, 48, 255))
            strip.alpha_composite(im.resize((s, s), Image.LANCZOS), (5, 5))
            sheet.paste(strip.convert("RGB"), (bx, 470))
            bx += s + 16
        x += cell_w + 26

    d.text((pad, 492), "16 / 32 / 64 / 128 px  actual size   (light bg / dark bg)",
           fill="#9aa1ad", font=f_note)
    sheet.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("用法: preview_sheet.py <out.png> <concept.png> ...")
    main(sys.argv[1], sys.argv[2:])
