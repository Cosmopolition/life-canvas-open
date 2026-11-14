/**
 * 复盘卡片（阶段五）—— 1080 × 1440（3:4 竖版，小红书比例）的 PNG。
 *
 * ★ **不是截图，是重排**：从周画布里挑几个点，排成一张竖版长图。
 *   截图 = 画布长什么样；重排 = 这一周你想给人看什么。
 *
 * ★ 硬约束：软件不生成总结文字。
 *   卡片上的每一个字都是用户自己写的 —— 这里只做「排版 + 渲染」。
 *   所以这个模块里没有任何"总结""归纳"" highlights"之类的逻辑。
 *
 * 为什么离屏 canvas：主画布的 renderer 是**实时画布**（LOD、命中框、补间），
 *   那套逻辑跟"排一张定版的长图"完全是两回事，硬套只会得到一堆 bug。
 *
 * 分两层：
 *   planCard()  —— 纯算：排版决策（折行、块高、要不要缩、要不要截）。**不碰 canvas**。
 *   renderReviewCard() —— 画：按 planCard 的结果往离屏 canvas 上画。
 * 分层是为了能单测 —— 排版是最容易错的地方。
 */
import { nodeTypeLabel } from '../model/types';
import type { LifeNode } from '../model/types';
import { PAL, uiFont } from '../canvas/renderer';
import { t } from '../i18n';

/** 卡片尺寸（逻辑像素）。实际后备存储 = 尺寸 × dpr。 */
export const CARD_W = 1080;
export const CARD_H = 1440;
/** 后备存储倍率 —— 2 倍在手机上看是清晰的，1080 的图在小红书上也够。 */
export const CARD_DPR = 2;

export const PAD = 72;          // 四边留白
export const GAP = 40;          // 内容块之间的间距
export const IMG_RATIO = 0.72;  // 图块的高 / 宽（4:3 左右）
/** 缩到这个倍数以下字就看不清了 —— 再放不下就截断，并告诉用户 */
export const MIN_SCALE = 0.62;

/** 三种字号 */
export interface FontSpec { weight: number; size: number }
export const F_TITLE: FontSpec = { weight: 600, size: 26 };
export const F_BODY: FontSpec = { weight: 400, size: 22 };
export const F_META: FontSpec = { weight: 400, size: 16 };
export const TITLE_LH = 34;
export const BODY_LH = 36;
export const META_LH = 24;

/** 量一段文字有多宽（给定字体下） */
export type Measure = (text: string, font: FontSpec) => number;

export type CardTheme = 'dark' | 'light' | 'high';

export interface ReviewCardOpts {
  /** 已按用户排序的节点 */
  nodes: LifeNode[];
  /** '第 45 周' */
  weekLabel: string;
  /** '11/02–11/08' */
  rangeText: string;
  theme: CardTheme;
  /** 落款那一行 */
  showFooter: boolean;
  /** 落款文字（默认「人生画布 · 周复盘」） */
  footerText?: string;
  dpr?: number;
}

export interface ReviewCardResult {
  canvas: HTMLCanvasElement;
  /** 内容超出卡片底部被截掉了 —— 预览里要告诉用户 */
  clipped: boolean;
  /** 没能进卡片的图（外链拉不下来 / 解码失败） */
  skippedImages: number;
  /**
   * 卡片上会出现的每一行**正文**（标题行 + 正文行）。
   *
   * ★ 存在的理由：这是「软件不生成总结文字」这条硬约束的**可核对证据** ——
   *   每一行都必须是用户原文的片段。自测直接断言这一点。
   */
  lines: string[];
  /**
   * 卡片上那几行小字：`类型 · 时间`。
   *
   * ⚠️ 它**不是**用户原文的片段，所以不能混进 lines ——
   *   但它也不是"生成"：类型和时间都是节点上现成的字段，
   *   只是把两个事实摆在一行上（按硬约束的口径，属于"能直接查出来的事实"）。
   */
  metaLines: string[];
}

/* ============================================================
 * 排版（纯逻辑 —— 不碰 canvas，可单测）
 * ============================================================ */

/** 一个内容块 */
export interface CardBlock {
  nodeId: string;
  /** 图块：有图；文字块：无图 */
  kind: 'image' | 'text';
  /** 标题折好的行 */
  titleLines: string[];
  /** 正文折好的行（无正文 = 空数组） */
  bodyLines: string[];
  /** 那一行小字：类型 · 时间（**只显示事实**，不评价） */
  meta: string;
  /** 这个块多高 */
  h: number;
}

export interface CardPlan {
  blocks: CardBlock[];
  /** 内容区整体缩放倍率 */
  scale: number;
  /** 缩不动了、底部被截掉 */
  clipped: boolean;
  /** 内容区总高（未缩放） */
  totalH: number;
  /** 内容区可用高 */
  availH: number;
}

/**
 * 按像素宽度折行。
 *
 * ⚠️ 为什么不用 text-layout.ts 那套估算：那张卡是要**发出去的**，
 *   字溢出边框就是成品不合格。宁可慢一点，也要用真的 measureText。
 *
 * 断行规则：中日韩按字断（中文没有词边界），拉丁按词断（不把单词劈两半）。
 */
export function wrapText(measure: Measure, text: string, maxWidth: number, font: FontSpec): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let cur = '';
    let curW = 0;
    for (const tok of tokenize(para)) {
      const w = measure(tok, font);
      if (curW + w > maxWidth && cur) {
        // 折行处的空格不带到下一行（否则会多出一行"只有一个空格"的行）
        if (tok === ' ') { out.push(cur); cur = ''; curW = 0; continue; }
        out.push(cur);
        cur = tok; curW = w;
      } else {
        cur += tok; curW += w;
      }
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [''];
}

/** 切成"断行单元"：CJK 单字一个，ASCII 词一个（词内不拆） */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const ch of s) {
    if (isCjk(ch) || ch === ' ') {
      if (buf) { out.push(buf); buf = ''; }
      out.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function isCjk(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x2e80 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) ||
    (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff00 && c <= 0xff60);
}

/**
 * 排版决策：折行、块高、要不要缩放、要不要截断。
 *
 * 放不下时**整体缩放**内容区（不截断）——
 * 悄悄截掉用户自己写的字，比字小一点糟糕得多。
 * 真放到缩不动了才截，并在结果里标出来，让预览告诉用户。
 *
 * @param withImage 这个节点**实际**有没有图（图没拉下来 ⇒ 当文字块排）
 */
export function planCard(
  nodes: LifeNode[],
  opts: { showFooter: boolean; withImage: (n: LifeNode) => boolean },
  measure: Measure,
): CardPlan {
  const cw = CARD_W - PAD * 2;
  const blocks: CardBlock[] = [];

  for (const n of nodes) {
    const titleLines = wrapText(measure, n.title, cw, F_TITLE);
    const body = n.content.trim();
    const bodyLines = body ? wrapText(measure, body, cw, F_BODY) : [];
    const meta = metaLine(n);
    const img = opts.withImage(n);
    const titleH = titleLines.length * TITLE_LH;
    const bodyH = bodyLines.length ? 12 + bodyLines.length * BODY_LH : 0;
    const metaH = meta ? 10 + META_LH : 0;
    const h = img
      ? Math.round(cw * IMG_RATIO) + 14 + titleH + bodyH + metaH
      : titleH + bodyH + metaH;
    blocks.push({
      nodeId: n.id,
      kind: img ? 'image' : 'text',
      titleLines,
      bodyLines,
      meta,
      h,
    });
  }

  const top = headHeight();
  const footH = opts.showFooter ? 56 : 0;
  const availH = CARD_H - PAD - footH - top;
  const totalH = blocks.reduce((a, b) => a + b.h, 0) + Math.max(0, blocks.length - 1) * GAP;

  let scale = 1;
  if (totalH > availH && totalH > 0) scale = availH / totalH;
  let clipped = false;
  if (scale < MIN_SCALE) { scale = MIN_SCALE; clipped = true; }

  return { blocks, scale, clipped, totalH, availH };
}

/** 标题区多高（周次 + 区间 + 分隔线） */
export function headHeight(): number {
  return PAD + 46 + 28;
}

/** 节点的那行小字：类型 · 时间（**只显示事实**，不评价） */
export function metaLine(n: LifeNode): string {
  const parts = [nodeTypeLabel(n.type)];
  if (n.time) parts.push(n.time);
  return parts.join(' · ');
}

/* ============================================================
 * 图片
 * ============================================================ */

/**
 * 把节点的图变成一张能安全画进 canvas 的图。
 *
 * ⚠️ **外链图（imageUrl）必须先转成 dataURL**：
 *   直接 drawImage 一个跨域 URL 会**污染 canvas**，
 *   之后 toDataURL 直接抛 SecurityError —— 整张卡导不出去。
 *   转成 dataURL 之后就是同源的，不会污染。
 */
async function loadNodeImage(n: LifeNode): Promise<HTMLImageElement | null> {
  const src = n.imageData ?? n.imageUrl;
  if (!src) return null;
  let url: string = src;
  if (!n.imageData && n.imageUrl) {
    const fetched = await fetchAsDataUrl(n.imageUrl);
    if (!fetched) return null;
    url = fetched;
  }
  const img = new Image();
  img.src = url;
  try {
    const d = (img as HTMLImageElement & { decode?: () => Promise<void> }).decode?.();
    if (d && typeof d.then === 'function') await d;
  } catch { return null; }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** 跨域 URL → dataURL（拉不到就 null） */
async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { signal: ctrl.signal, mode: 'cors' });
    clearTimeout(timer);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/* ============================================================
 * 主渲染
 * ============================================================ */

interface Pal {
  card: string; border: string; text: string; faint: string; dim: string;
  bg: string; accent: string;
}

function paletteOf(theme: CardTheme): Pal {
  const p = theme === 'light' ? PAL.light : theme === 'high' ? PAL.high : PAL.normal;
  return {
    card: p.card, border: p.border, text: p.text, faint: p.faint, dim: p.dim,
    bg: p.bg, accent: p.accent,
  };
}

/**
 * 渲染一张复盘卡片。
 *
 * 版式（1080×1440）：
 *   标题区：周次 + 区间 + 一道分隔线
 *   内容区：用户挑的节点（文字块 / 图块）
 *   落款：人生画布 · 周复盘
 */
export async function renderReviewCard(opts: ReviewCardOpts): Promise<ReviewCardResult> {
  const dpr = opts.dpr ?? CARD_DPR;
  const pal = paletteOf(opts.theme);
  const font = uiFont();

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W * dpr;
  canvas.height = CARD_H * dpr;
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);

  // 底
  g.fillStyle = pal.bg;
  g.fillRect(0, 0, CARD_W, CARD_H);

  const cw = CARD_W - PAD * 2;

  /* ---------- 先把图拉下来 ---------- */
  const imgs = new Map<string, HTMLImageElement | null>();
  let skippedImages = 0;
  for (const n of opts.nodes) {
    const img = await loadNodeImage(n);
    imgs.set(n.id, img);
    if ((n.imageData ?? n.imageUrl) && !img) skippedImages++;
  }

  /* ---------- 量（真 measureText） ---------- */
  const measure: Measure = (text, f) => {
    g.font = `${f.weight} ${f.size}px ${font}`;
    return g.measureText(text).width;
  };
  const plan = planCard(opts.nodes, {
    showFooter: opts.showFooter,
    withImage: (n) => !!imgs.get(n.id),
  }, measure);

  /* ---------- 标题区 ---------- */
  g.textBaseline = 'top';
  g.textAlign = 'left';
  g.fillStyle = pal.accent;
  g.font = `500 26px ${font}`;
  g.fillText(opts.weekLabel, PAD, PAD);

  g.fillStyle = pal.text;
  g.font = `600 46px ${font}`;
  g.fillText(opts.rangeText, PAD, PAD + 40);

  const headBottom = headHeight();
  g.fillStyle = pal.border;
  g.fillRect(PAD, headBottom, cw, 1);

  /* ---------- 内容区 ---------- */
  const top = headBottom + 36;

  g.save();
  g.translate(PAD, top);
  if (plan.scale !== 1) g.scale(plan.scale, plan.scale);
  // 每个块自己的 y 在 planCard 里算好了（b.y），drawBlock 内部会读 ——
  // 这里不再累加，累加出来的那条线从来没被读过。
  for (const b of plan.blocks) {
    drawBlock(g, b, imgs.get(b.nodeId) ?? null, pal, font, cw);
  }
  g.restore();

  /* ---------- 落款 ---------- */
  if (opts.showFooter) {
    g.fillStyle = pal.faint;
    g.font = `400 18px ${font}`;
    g.textBaseline = 'alphabetic';
    g.fillText(opts.footerText ?? t('app.nameWeeklyReview'), PAD, CARD_H - PAD + 4);
  }

  return { canvas, clipped: plan.clipped, skippedImages, lines: cardLines(plan), metaLines: cardMetaLines(plan) };
}

/** 卡片上的正文文字（标题行 + 正文行），给自测核对用 */
export function cardLines(plan: CardPlan): string[] {
  const out: string[] = [];
  for (const b of plan.blocks) {
    for (const l of b.titleLines) if (l) out.push(l);
    for (const l of b.bodyLines) if (l) out.push(l);
  }
  return out;
}

/** 卡片上的小字行（`类型 · 时间`） */
export function cardMetaLines(plan: CardPlan): string[] {
  return plan.blocks.map((b) => b.meta).filter(Boolean);
}

/** 画一个内容块 */
function drawBlock(
  g: CanvasRenderingContext2D, b: CardBlock,
  img: HTMLImageElement | null,
  pal: Pal, font: string, cw: number,
): void {
  let y = 0;
  if (b.kind === 'image' && img) {
    const ih = Math.round(cw * IMG_RATIO);
    drawCover(g, img, 0, y, cw, ih, 16);
    y += ih + 14;
  }
  // 标题
  g.textBaseline = 'top';
  g.textAlign = 'left';
  g.fillStyle = pal.text;
  g.font = `600 26px ${font}`;
  for (const l of b.titleLines) {
    g.fillText(l, 0, y);
    y += TITLE_LH;
  }
  // 正文
  if (b.bodyLines.length) {
    y += 12;
    g.fillStyle = pal.dim;
    g.font = `400 22px ${font}`;
    for (const l of b.bodyLines) {
      g.fillText(l, 0, y);
      y += BODY_LH;
    }
  }
  // 小字
  if (b.meta) {
    y += 10;
    g.fillStyle = pal.faint;
    g.font = `400 16px ${font}`;
    g.fillText(b.meta, 0, y);
    y += META_LH;
  }
}

/** cover 裁切：铺满整块，多出来的裁掉（不留黑边） */
function drawCover(
  g: CanvasRenderingContext2D, img: HTMLImageElement,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const iw = img.naturalWidth || 1;
  const ih = img.naturalHeight || 1;
  const k = Math.max(w / iw, h / ih);
  const dw = iw * k, dh = ih * k;
  g.save();
  roundRect(g, x, y, w, h, r);
  g.clip();
  try { g.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); } catch { /* 忽略 */ }
  g.restore();
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}
