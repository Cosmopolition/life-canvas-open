/** 视口变换：world ↔ screen。缩放锚定光标（§6.1） */

export interface Viewport { tx: number; ty: number; scale: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const MIN_SCALE = 0.08;
export const MAX_SCALE = 4;
export const LABEL_SCALE = 0.6;

export const clampScale = (s: number): number => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

export function screenToWorld(v: Viewport, sx: number, sy: number): [number, number] {
  return [(sx - v.tx) / v.scale, (sy - v.ty) / v.scale];
}

export function worldToScreen(v: Viewport, wx: number, wy: number): [number, number] {
  return [wx * v.scale + v.tx, wy * v.scale + v.ty];
}

/** 以 (ax, ay)（屏幕坐标）为不动点缩放 */
export function zoomAt(v: Viewport, ax: number, ay: number, factor: number): Viewport {
  const next = clampScale(v.scale * factor);
  const k = next / v.scale;
  return { scale: next, tx: ax - (ax - v.tx) * k, ty: ay - (ay - v.ty) * k };
}

/** 当前可见的 world 矩形 */
export function visibleWorld(v: Viewport, width: number, height: number): Rect {
  const [x0, y0] = screenToWorld(v, 0, 0);
  const [x1, y1] = screenToWorld(v, width, height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface FitTarget { tx: number; ty: number; scale: number }

/**
 * 把一批矩形装进视口。
 *
 * `minScale` 是**下限**（安全网，不是常规约束）。
 *
 * 为什么以前需要一个「可读下限」：渲染器在缩放 < LOD_SCALE(0.45) 时走低细节度路径，
 * 那条路径早期只画实心色块、**一个字都不画** ——
 * 于是"自适应"到 30% 的视图就是一片橙色方块：看得见那儿有点，认不出那是什么。
 * 阶段一铺开（点按时间从左到右排开）必然落到这个缩放。
 *
 * 现在低细节度路径自己分级了（节点少 → 画概览卡片 + 常驻屏幕字号的标题），
 * 缩到 20% 也认得出每个点叫什么，所以 fit 可以放心地真的把数据装下 ——
 * 「显示某个阶段的全部数据」和「自适应」不该互相打架。
 * minScale 只留给明确要求"不许再小"的场合。
 */
export function fitTo(
  items: readonly Rect[], width: number, height: number,
  pad = 78, maxScale = 1.15, minScale = 0,
): FitTarget | null {
  if (!items.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of items) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const scale = clampScale(Math.max(
    minScale,
    Math.min((width - pad * 2) / w, (height - pad * 2) / h, maxScale),
  ));
  return {
    scale,
    tx: width / 2 - ((x0 + x1) / 2) * scale,
    ty: height / 2 - ((y0 + y1) / 2) * scale,
  };
}

/** 300ms easeOutCubic 过渡 */
export function animateViewport(
  from: Viewport, to: FitTarget, dur = 300, onFrame: (v: Viewport) => void,
): () => void {
  const t0 = performance.now();
  let raf = 0;
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    onFrame({
      tx: from.tx + (to.tx - from.tx) * e,
      ty: from.ty + (to.ty - from.ty) * e,
      scale: from.scale + (to.scale - from.scale) * e,
    });
    if (p < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export const rectContains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
