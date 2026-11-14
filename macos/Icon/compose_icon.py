#!/usr/bin/env python3
"""
compose_icon.py — 把 AI 生成的图标稿合成为符合 macOS 规范的最终图标。

模型出图有三个必须修的毛病：
  1. 「透明背景」被画成了**棋盘格**并烤进像素（RGB 图，没有 alpha）
  2. 轮廓是 iOS 风格的大圆角，不是 macOS 的连续圆角 squircle
  3. 形状外缘多了一圈灰色描边

处理步骤：
  1) 按亮度抠出图标主体（棋盘格是浅灰 211/251，主体是深色，一刀切得开）
  2) 填掉主体内部的洞（节点高光可能过阈值）
  3) 腐蚀掉那圈灰描边
  4) 用极坐标外推把四角补满（AI 的圆角比 macOS 的圆，角上会缺料）
  5) 重新套用精确的 macOS squircle（1024 画布 / 824 主体 / 100 边距 / n=5 超椭圆）
  6) 加投影 + 顶部边缘高光

用法：compose_icon.py <源图> <输出png> [输出边长]
"""

import sys
import numpy as np
from PIL import Image, ImageFilter
from scipy.ndimage import binary_fill_holes, binary_closing, binary_opening, label

# ---- macOS 图标规范 ----
CANVAS = 1024          # master 画布
BODY = 824             # 主体边长（四周留 100）
MARGIN = 100
SQUIRCLE_N = 5.0       # 超椭圆指数：n=5 在 45° 处与圆角矩形几乎重合，但曲率连续


def load_body(path):
    """抠出图标主体，返回 (H,W,3) float RGB 与 (H,W) bool mask。"""
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    lum = a.mean(axis=2)

    # 棋盘格浅灰 211~251；主体深色。用 180 切，主体内最亮的节点也留得住。
    mask = lum < 180.0

    # 形状边缘常被模型画成一圈浅灰描边/倒角（中性灰 + 中等亮度）。
    # 饱和度阈值收紧到 max-min<14，才不会误伤顶部那些偏蓝的浅色渐变。
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    neutral_gray = (mx - mn < 14) & (lum > 105) & (lum < 200)
    mask = mask & ~neutral_gray

    # 形状边缘常有一排点阵被阈值切成「梳齿」状碎块（源图边缘的点阵正好压在
    # 明暗交界上）。先闭运算填缝、再开运算削掉细齿，最后只保留最大连通域。
    st = np.ones((9, 9), dtype=bool)
    mask = binary_closing(mask, st)
    mask = binary_opening(mask, st)
    lab, n = label(mask)
    if n > 1:
        sizes = np.bincount(lab.ravel())
        sizes[0] = 0
        mask = lab == int(sizes.argmax())

    # 填掉主体内部的洞（节点高光可能超过阈值）
    mask = binary_fill_holes(mask)

    # 腐蚀掉外缘那圈灰描边（模型给形状加的亮边约 10px@2048）。
    # 腐蚀掉的这一圈随后由 extend_corners 沿径向补回深色主体，不留灰边。
    mimg = Image.fromarray((mask * 255).astype(np.uint8))
    mimg = mimg.filter(ImageFilter.MinFilter(21))
    mask = np.asarray(mimg) > 127

    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        raise SystemExit(f"没抠出主体：{path}")
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    return a[y0:y1, x0:x1], mask[y0:y1, x0:x1]


def extend_corners(rgb, mask, blur=18):
    """把主体外的四角补满：沿每条射线取边界处（模糊过的）颜色外推。"""
    H, W = rgb.shape[:2]
    cy, cx = (H - 1) / 2.0, (W - 1) / 2.0
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    dx, dy = xx - cx, yy - cy
    r = np.hypot(dx, dy)
    th = np.arctan2(dy, dx)

    nb = 4096
    ib = ((th + np.pi) / (2 * np.pi) * nb).astype(int).ravel()
    rb = r.ravel()
    mb = mask.ravel()
    maxr = np.full(nb, -1.0, dtype=np.float32)
    np.maximum.at(maxr, ib[mb], rb[mb])
    valid = maxr >= 0
    if not valid.any():
        return rgb
    idx = np.arange(nb)
    maxr = np.interp(idx, idx[valid], maxr[valid])
    R = maxr[ib].reshape(H, W)

    # 外推取色用模糊版，避免网点被拉成放射状条纹
    smooth = np.asarray(
        Image.fromarray(rgb.astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur)),
        dtype=np.float32)
    rsrc = np.minimum(r, R)
    xs = np.clip(np.round(cx + rsrc * np.cos(th)).astype(int), 0, W - 1)
    ys = np.clip(np.round(cy + rsrc * np.sin(th)).astype(int), 0, H - 1)
    return np.where(mask[..., None], rgb, smooth[ys, xs])


def squircle_alpha(px, ss=4):
    """精确的 macOS 连续圆角 squircle 抗锯齿遮罩。"""
    W = px * ss
    a = BODY * ss / 2.0
    c = W / 2.0
    yy, xx = np.mgrid[0:W, 0:W].astype(np.float32)
    X = np.abs(xx + 0.5 - c) / a
    Y = np.abs(yy + 0.5 - c) / a
    inside = (X ** SQUIRCLE_N + Y ** SQUIRCLE_N) <= 1.0
    al = inside.astype(np.float32).reshape(px, ss, px, ss).mean(axis=(1, 3))
    return al


def compose(src, out, size=CANVAS):
    rgb, mask = load_body(src)
    rgb = extend_corners(rgb, mask)

    # 主体缩放后放进画布
    side = int(BODY * size / CANVAS)
    art = Image.fromarray(rgb.astype(np.uint8)).resize((side, side), Image.LANCZOS)
    art = np.asarray(art).astype(np.float32)
    m = Image.fromarray((mask * 255).astype(np.uint8)).resize((side, side), Image.LANCZOS)
    art_mask = np.asarray(m).astype(np.float32) / 255.0

    off = int(MARGIN * size / CANVAS)
    canvas_rgb = np.zeros((size, size, 3), dtype=np.float32)
    canvas_a = np.zeros((size, size), dtype=np.float32)
    canvas_rgb[off:off + side, off:off + side] = art
    canvas_a[off:off + side, off:off + side] = art_mask

    # 用精确的 squircle 重新裁形
    sq = squircle_alpha(size)
    body_a = (canvas_a * sq)
    # 主体外的部分不该有任何像素（外推出来的角落要保留）
    body_rgb = canvas_rgb

    # ---- 投影 ----
    shadow = Image.fromarray((body_a * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(size * 0.022))
    sh = np.asarray(shadow).astype(np.float32) / 255.0
    sh = np.roll(sh, int(size * 0.012), axis=0)
    sh_rgb = np.zeros_like(body_rgb)
    out_rgb = body_rgb * body_a[..., None] + sh_rgb * (sh * 0.42)[..., None]
    out_a = np.clip(body_a + sh * 0.42, 0, 1)

    # ---- 顶部边缘高光（macOS 图标的边缘反光）----
    rim = Image.fromarray((sq * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(size * 0.004))
    rim_a = np.asarray(rim).astype(np.float32) / 255.0
    yy = np.linspace(0, 1, size, dtype=np.float32)[:, None]
    falloff = np.clip(1.0 - yy / 0.55, 0, 1) ** 1.6
    rim_strength = (rim_a * falloff * 0.16)[..., None]
    out_rgb = out_rgb + rim_strength * 255.0
    out_rgb = np.clip(out_rgb, 0, 255)

    # ---- 内侧一圈 1px 亮边 ----
    edge = Image.fromarray((sq * 255).astype(np.uint8)).filter(ImageFilter.FIND_EDGES)
    edge_a = np.asarray(edge).astype(np.float32) / 255.0
    out_rgb = np.clip(out_rgb + (edge_a * 13)[..., None], 0, 255)

    rgba = np.dstack([out_rgb, out_a * 255.0]).astype(np.uint8)
    Image.fromarray(rgba, "RGBA").save(out)
    print(f"wrote {out} ({size}px)")


def compose_fullbleed(src, out, size=1024):
    """★ App Store 用的满幅方图（无 alpha）。

    为什么不能直接用 master：
        master 是 **macOS 图标** —— 1024 画布上放一个 824 的 squircle，四角是透明的
        （macOS 允许图标带 alpha，Finder 自己会裁）。
        但 **App Store 的 1024 图标必须满幅、无 alpha**：Apple 会用自己的圆角遮罩，
        你再带一层透明角 = 四角被抠成别的颜色。
        （App Store Connect 对 1024 图标的硬要求：RGB、不透明、无 alpha。）

    做法：把主体**先外推角落**（extend_corners）再铺满整张画布，
    不套 squircle 遮罩 —— 满幅版没有"边界"可言，边界就是画布本身。
    """
    rgb, mask = load_body(src)
    rgb = extend_corners(rgb, mask)
    art = Image.fromarray(rgb.astype(np.uint8)).resize((size, size), Image.LANCZOS)
    # RGB 模式保存 ⇒ 文件里没有 alpha 通道（这正是 ASC 要的）
    art.convert("RGB").save(out)
    print(f"wrote {out} ({size}px, 满幅, 无 alpha)")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("用法: compose_icon.py <源图> <输出png> [边长] [--fullbleed]")
    args = [a for a in sys.argv[1:] if a != "--fullbleed"]
    size = int(args[2]) if len(args) > 2 else CANVAS
    if "--fullbleed" in sys.argv[1:]:
        compose_fullbleed(args[0], args[1], size)
    else:
        compose(args[0], args[1], size)
