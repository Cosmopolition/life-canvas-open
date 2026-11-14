/**
 * 分层绘制主循环（§6.3）。严格按层序，不可交叉。
 */
import {
  EDGE_TYPE_COLOR, edgeTypeLabel, NODE_TYPE_COLOR, nodeTypeLabel, STATUS_COLOR, statusLabel,
  type EdgeType, type Library, type LifeNode, type LifeStage, type LifeTheme, type NodeType,
} from '../model/types';
// 这里的主题循环变量就叫 t（theme），跟文案函数 t() 撞名 ——
// 渲染层里 t 一律指主题，所以文案函数在这个文件里改用 i18n 别名。
import { t as i18n } from '../i18n';
import {
  derivedStageBelongEdges, derivedThemeBelongEdges,
  graphRevision,
  inStage, inTheme, nodesInStage, nodesInTheme, themeChain,
} from '../model/selectors';
import { LABEL_SCALE, type Rect, type Viewport, worldToScreen } from './viewport';
import { EdgeGeometry, anchorPoints, edgeCurve, nodeSizeOf, type EdgeCurve } from './edge-geometry';
import { LayoutCache, ellipsize, measure } from './text-layout';
import type { GridIndex } from './spatial-index';

export interface RenderInput {
  lib: Library;
  vp: Viewport;
  width: number;
  height: number;
  dpr: number;
  /**
   * 多维焦点。两者可都设（交集）、单设或都空（全显）。
   * @deprecated 旧单焦点字段，过渡期由 app 层用 themeId 兜底。renderer 读新字段。
   */
  areaId: string | null;
  /** 主题焦点：节点须满足 `inTheme` */
  focusThemeId: string | null;
  /** 阶段焦点：节点须满足 `inStage`（显式 ∪ 时基） */
  focusStageId: string | null;
  nodeTypes: ReadonlySet<NodeType> | null;
  selected: ReadonlySet<string>;
  hovered: string | null;
  searchActive: boolean;
  /** 高对比度：Canvas 2D 不吃 CSS 变量，必须显式切色板 */
  contrast: boolean;
  /** 主题：暗色 / 亮色。Canvas 不读 CSS 变量，必须显式切色板 */
  theme: 'dark' | 'light';
  /** 筛选透镜：不在其中的点压暗 */
  lens: ReadonlySet<string>;
  hits: ReadonlySet<string>;
  ctxSet: ReadonlySet<string>;
  /** 当前 hover 的边 id — 视觉上变红 + 加粗，画布上可点删 */
  hoverEdgeId: string | null;
  /**
   * 不画主题 / 阶段的框与标签。
   *
   * 周画布用：它是"这一周的复盘"，不是主画布那张主题地图 ——
   * 把全局主题框搬进来只会让人以为"这一周也有阶段面"。
   */
  hideAreas: boolean;
  /** 当前选中的边 id — 高亮 + 画出类型徽标，画布上可编辑 */
  selectedEdgeId: string | null;
  linking: { fromId: string; sx: number; sy: number; valid: ReadonlySet<string>; type: EdgeType } | null;
  marquee: Rect | null;
  index: GridIndex;
}

// 阈值对齐"文字开始可读"的缩放：低于此值画文字纯属浪费，
// 而精细路径的描边/贝塞尔边又比 LOD 贵一个量级
const LOD_SCALE = 0.45;
/** LOD 下最多画多少条边，超出按关系重要性截断 */
const LOD_EDGE_MAX = 2500;
/** LOD 下节点少到多少时才画「概览卡片」（超出就只画合并色块，保住 1 万点的帧率） */
const LOD_CARD_MAX = 600;
/** 概览卡片标题的屏幕字号（px）—— 恒定，与缩放无关 */
const LOD_LABEL_PX = 11;
/** 概览卡片里封面图缩略图的屏幕宽度（px）—— 恒定，与缩放无关 */
const LOD_THUMB_PX = 26;

/**
 * 画布用的字体族。
 *
 * ⚠️ 为什么不能直接写 `var(--ui-font, system-ui)`：
 *    canvas 的 `ctx.font` 是 CSS font shorthand，但它**不认 CSS 变量** ——
 *    含 `var()` 的整条赋值会被判为非法而**静默忽略**，
 *    画布悄悄退回默认的 `10px sans-serif`。
 *
 *    后果不是"字体不一样"，是"字号全错"：
 *    概览卡片写的是 `11 / scale`（想让它常驻 11 屏幕像素），
 *    实际画出来的是 10 **世界**像素 —— 缩到 25% 就是 2.5 屏幕像素，
 *    缩略图上写「常驻屏幕字号」的标题根本看不见。
 *    而且没有任何报错，只是"字太小"。
 *
 *    所以这里把变量**读出来**再用。
 */
let uiFontCache = '';
export function uiFont(): string {
  if (uiFontCache) return uiFontCache;
  const v = (getComputedStyle(document.documentElement).getPropertyValue('--ui-font') || '').trim();
  // CSS 还没加载上时**不缓存**：缓存一个空值会让字体永远错下去
  if (!v) return 'system-ui, sans-serif';
  uiFontCache = v;
  return uiFontCache;
}

/** 三套色板：暗色 / 高对比 / 亮色。Canvas 不读 CSS 变量，每套独立维护。 */
export const PAL = {
  normal: {
    card:'#222630', cardSel:'#272c37', border:'#2f3542', borderHover:'#3d4553',
    text:'#e7e9ee', faint:'#626a79', dim:'#949cab',
    bg:'#16181d', bgDot:'#232830', ok:'#6fae8f', accent:'#e0a458', accentSoft:'rgba(224,164,88,.12)',
  },
  high: {
    card:'#181b21', cardSel:'#1f232b', border:'#5a6373', borderHover:'#7b8595',
    text:'#ffffff', faint:'#98a1b0', dim:'#c6ccd6',
    bg:'#0b0c0f', bgDot:'#1c1f26', ok:'#7fc0a0', accent:'#f0b46e', accentSoft:'rgba(240,180,110,.18)',
  },
  light: {
    card:'#ffffff', cardSel:'#fbf9f4', border:'#d6cfc0', borderHover:'#a8967d',
    text:'#2a2622', faint:'#8c8576', dim:'#5b554c',
    bg:'#faf7f2', bgDot:'#e6e1d5', ok:'#5e8a72', accent:'#b8722e', accentSoft:'rgba(184,114,46,.12)',
  },
} as const;

/** 选色板：浅色压倒 contrast；暗色下按 contrast 二选一 */
function pickPal(inp: RenderInput) {
  if (inp.theme === 'light') return PAL.light;
  return inp.contrast ? PAL.high : PAL.normal;
}

export class Renderer {
  private layout = new LayoutCache();
  /** id 索引：anchorOf 若用 find，2 万条边就是 4 万次 O(n) 查找 → 单帧秒级 */
  private nIdx = new Map<string, LifeNode>();
  private tIdx = new Map<string, LifeTheme>();
  private sIdx = new Map<string, LifeStage>();
  private buildIndex(lib: Library): void {
    if (this.nIdx.size === lib.nodes.length &&
        this.tIdx.size === lib.themes.length &&
        this.sIdx.size === lib.stages.length) return;
    this.nIdx = new Map(lib.nodes.map((n) => [n.id, n]));
    this.tIdx = new Map(lib.themes.map((t) => [t.id, t]));
    this.sIdx = new Map(lib.stages.map((s) => [s.id, s]));
  }


  private sizeCache = new Map<string, { w: number; h: number; key: string }>();
  /** 连线几何（锚点 / 曲线 / 分道）。画、命中、选中共用这一份 */
  private geo = new EdgeGeometry();
  private lodEdgeCache: { n: number; rev: number; edges: readonly import('../model/types').LifeEdge[] } | null = null;
  /** LOD 下按类型缓存的点路径。每帧重建 1 万个 Path2D 矩形是纯浪费，节点很少动 */
  private lodNodePaths = new Map<string, Path2D>();
  private lodPathsValid = false;

  /** 节点尺寸（world 单位）。命中率高到值得缓存：areaBox / anchorOf / drawNode 都要用 */
  static nodeSizeOf(n: LifeNode, cache: Map<string, { w: number; h: number; key: string }>): { w: number; h: number } {
    const hasImg = (n.imageData ?? n.imageUrl) ? 'i' : '_';
    const key = `${n.w}x${n.h}x${n.title.length}x${hasImg}`;
    const hit = cache.get(n.id);
    if (hit && hit.key === key) return hit;
    // 尺寸规则只有一份（edge-geometry）—— 这里只负责缓存
    const out = nodeSizeOf(n);
    cache.set(n.id, { ...out, key });
    return out;
  }

  /** Image 元素缓存：dataURL/URL → HTMLImageElement。getImageOrLoad 找不到时异步加载 */
  private imageCache = new Map<string, HTMLImageElement>();
  /**
   * **真正能画了**的图（decode() 兑现了）。
   *
   * ⚠️ 为什么要单独记一份：
   *    `onload` 只说明"数据到了"，不说明"能画了"。
   *    WebKit 里一张 complete && naturalWidth > 0 的图，drawImage 仍可能画不出东西
   *    （解码还没完成）—— 症状是「右栏检视面板里图清清楚楚，画布上永远是块灰底」。
   *    而且它是**偶发**的：解码够快就画得出来，不够快就画不出来，
   *    换个缩放级别（走另一条渲染路径）又画出来了 —— 最难查的那种。
   *
   *    所以：decode() 兑现之后才算"能画"，那时候才重绘。
   */
  private imageDecoded = new Set<string>();
  /**
   * 图片 decode 完了要回调一次 —— 让画布**再画一帧**。
   *
   * ⚠️ 为什么必须有：图片加载是异步的，贴图那一帧图还没 decode 完，
   *    画的是占位底色。之后渲染循环只在"脏"的时候重绘，
   *    而贴图已经触发过一次重绘了 —— 于是**图永远显示不出来**。
   *    （症状：右栏检视面板里图看得清清楚楚，画布上永远是块灰底。）
   */
  private onImageLoaded: (() => void) | null = null;
  setImageLoadedHandler(fn: (() => void) | null): void { this.onImageLoaded = fn; }
  /**
   * 这张图解开了吗（自测 / 截图用）。
   *
   * 「贴图之后画布上有没有图」这件事不能用「等 0.8 秒」来判断 ——
   * 那是赌 decode 够快。要么 decode 完了（这里返回 true），
   * 要么还没（图还没进缓存）。等一个**信号**，不要等一个时长。
   */
  isImageReady(src: string): boolean {
    if (!this.imageDecoded.has(src)) return false;
    const img = this.imageCache.get(src);
    return !!img && img.complete && img.naturalWidth > 0;
  }
  private getImageOrLoad(src: string): HTMLImageElement | null {
    const hit = this.imageCache.get(src);
    // ⚠️ 只在**真的能画**的时候才把图交出去 ——
    //    「数据到了但没解码」的图交给 drawImage 会画出个寂寞（什么都没画）。
    //    这时候返回 null，画占位底色，等 decode 兑现后重绘。
    if (hit) return this.isImageReady(src) ? hit : null;
    const img = new Image();
    img.onload = () => {
      // decode() 兑现之后才重绘：那时 drawImage 才画得出东西。
      // 不支持 decode() 的环境退回 onload（那时通常也已经能画了）。
      const d = (img as HTMLImageElement & { decode?: () => Promise<void> }).decode?.();
      if (d && typeof d.then === 'function') {
        d.then(() => this.markDecoded(src), () => this.markDecoded(src));
      } else {
        this.markDecoded(src);
      }
    };
    img.src = src;
    // 失败也存：避免反复触发 decode；下次 resetIndexCache 时清掉
    this.imageCache.set(src, img);
    return null;
  }
  private markDecoded(src: string): void {
    this.imageDecoded.add(src);
    this.onImageLoaded?.();
  }

  static nodeSize(n: LifeNode): { w: number; h: number } {
    // 同一份尺寸规则（带图的节点会更高）—— 空间索引必须和画出来的一致
    return nodeSizeOf(n);
  }

  /** 供外部构建空间索引时取节点尺寸，保证和绘制用的是同一份缓存 */
  nodeSize(n: LifeNode): { w: number; h: number } { return Renderer.nodeSizeOf(n, this.sizeCache); }

  invalidate(id?: string): void { this.layout.invalidate(id); }
  /** 数据整体替换后必须强制重建 id 索引 */
  invalidateAll(): void { this.layout.invalidate(); this.rebuildIndexCache(); this.boxCache.clear(); this.lodEdgeCache = null; }
  /** 节点位置变了 → LOD 缓存的点路径失效 */
  invalidateBoxes(): void { this.boxCache.clear(); this.lodPathsValid = false; this.lodEdgeCache = null; this.geo.invalidateGeometry(); }

  private rebuildIndexCache(): void { this.nIdx = new Map(); this.tIdx = new Map(); this.sIdx = new Map(); }

  draw(g: CanvasRenderingContext2D, inp: RenderInput): void {
    const { vp, width, height, dpr } = inp;
    this.buildIndex(inp.lib);
    // 几何索引（LOD 和精细路径都要用）—— 一次 ensure，两边共用
    this.geo.ensure(inp.lib, graphRevision());
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);

    // 自绘底色与点阵（不再依赖 CSS <main> 透出来，确保主题切换一定生效）
    const p = pickPal(inp);
    g.fillStyle = p.bg;
    g.fillRect(0, 0, width, height);
    g.fillStyle = p.bgDot;
    const STEP = 28;
    for (let y = STEP / 2; y < height; y += STEP) {
      for (let x = STEP / 2; x < width; x += STEP) {
        g.beginPath();
        g.arc(x, y, 1, 0, Math.PI * 2);
        g.fill();
      }
    }

    // 统一世界变换
    g.save();
    g.translate(vp.tx, vp.ty);
    g.scale(vp.scale, vp.scale);

    // 全览（缩得很小）时走 LOD：所有点都在视口内，逐个精细绘制要秒级
    if (vp.scale < LOD_SCALE) {
      this.drawLod(g, inp);
    } else {
      if (!inp.hideAreas) this.drawAreas(g, inp);
      this.drawEdges(g, inp);
      this.drawNodes(g, inp);
    }
    g.restore();

    // 屏幕层：连线预览、框选
    this.drawOverlay(g, inp);
  }

  /**
   * 低细节度渲染：缩放小于 LOD_SCALE 时使用。
   * 目标不是好看，是"能看到全局结构"——单帧预算必须与视口内节点数解耦。
   * 三件事：点合并成 9 条 Path（按类型）、边合并成直线、全部跳过文字。
   */
  private drawLod(g: CanvasRenderingContext2D, inp: RenderInput): void {
    const { lib, vp, index } = inp;
    const view = {
      x: -vp.tx / vp.scale - 400, y: -vp.ty / vp.scale - 400,
      w: inp.width / vp.scale + 800, h: inp.height / vp.scale + 800,
    };
    // ⚠️ 焦点过滤**必须**在 LOD 里也生效 ——
    //    早期版本 LOD 直接把索引里的点全画了，于是"聚焦某个阶段"时，
    //    画布上出现的还是全部点：视图在骗人。细路径有过滤，LOD 也得有。
    const items = index.query(view).filter((it) => {
      if (inp.lens.size && !inp.lens.has(it.id)) return false;
      const n = this.nIdx.get(it.id);
      if (!n) return false;
      if (inp.nodeTypes && inp.nodeTypes.size && !inp.nodeTypes.has(n.type)) return false;
      if (inp.focusThemeId && !inTheme(lib, n, inp.focusThemeId)) return false;
      if (inp.focusStageId && !inStage(lib, n, inp.focusStageId)) return false;
      if (inp.searchActive && !inp.ctxSet.has(n.id) && !inp.hits.has(n.id)) return false;
      return true;
    });
    if (!items.length) return;

    // 节点少 → 走「概览卡片」：真卡片 + 常驻屏幕字号的标题。
    // 节点多 → 走合并色块（1 万点的性能红线，见 docs/ARCHITECTURE.md §6）。
    if (items.length <= LOD_CARD_MAX) {
      if (!inp.hideAreas) this.drawFocusFrame(g, inp);
      this.drawLodEdges(g, inp, new Set(items.map((it) => it.id)));
      this.drawLodCards(g, inp, items);
      return;
    }

    // 主题 / 阶段：只画一圈淡框
    if (!inp.hideAreas) {
      for (const t of lib.themes) {
        const b = this.themeBox(lib, t);
        g.globalAlpha = 0.05;
        g.strokeStyle = t.color;
        g.lineWidth = 1.2 / vp.scale;
        g.setLineDash([6 / vp.scale, 6 / vp.scale]);
        g.strokeRect(b.x, b.y, b.w, b.h);
        g.setLineDash([]);
      }
      // 阶段：只画当前焦点的（避免屏上叠满 N 个淡框）
      if (inp.focusStageId) {
        const s = lib.stages.find((x) => x.id === inp.focusStageId);
        if (s) {
          const b = this.stageBox(lib, s);
          g.globalAlpha = 0.18;
          g.strokeStyle = s.color;
          g.lineWidth = 1.5 / vp.scale;
          g.setLineDash([4 / vp.scale, 4 / vp.scale]);
          g.strokeRect(b.x, b.y, b.w, b.h);
          g.setLineDash([]);
        }
      }
      g.globalAlpha = 1;
    }

    this.drawLodEdges(g, inp, null);

    // 点：按类型合并。路径缓存复用 —— 只有节点动过才重建
    if (!this.lodPathsValid) {
      this.lodNodePaths.clear();
      for (const it of items) {
        const n = this.nIdx.get(it.id);
        if (!n) continue;
        let path = this.lodNodePaths.get(n.type);
        if (!path) { path = new Path2D(); this.lodNodePaths.set(n.type, path); }
        path.rect(n.x, n.y, n.w, n.h);
      }
      this.lodPathsValid = true;
    }
    g.globalAlpha = 0.95;
    for (const [type, path] of this.lodNodePaths) {
      g.fillStyle = NODE_TYPE_COLOR[type as NodeType];
      g.fill(path);
    }
    g.globalAlpha = 1;
  }

  /**
   * 焦点面的淡框（主题 / 阶段）。
   *
   * 概览卡片模式下要留这个锚点 —— 否则屏幕上就是一堆散落的卡片，
   * 看不出"这是那个阶段"。只画**当前焦点**的那个：15 个主题框全画出来
   * 是一片噪声（细路径也是只高亮焦点主题）。
   */
  private drawFocusFrame(g: CanvasRenderingContext2D, inp: RenderInput): void {
    const { lib, vp } = inp;
    g.globalAlpha = 0.18;
    if (inp.focusStageId) {
      const s = lib.stages.find((x) => x.id === inp.focusStageId);
      if (s) {
        const b = this.stageBox(lib, s);
        g.strokeStyle = s.color;
        g.lineWidth = 1.5 / vp.scale;
        g.setLineDash([4 / vp.scale, 4 / vp.scale]);
        g.strokeRect(b.x, b.y, b.w, b.h);
        g.setLineDash([]);
      }
    } else if (inp.focusThemeId) {
      const t = lib.themes.find((x) => x.id === inp.focusThemeId);
      if (t) {
        const b = this.themeBox(lib, t);
        g.strokeStyle = t.color;
        g.lineWidth = 1.5 / vp.scale;
        g.setLineDash([6 / vp.scale, 6 / vp.scale]);
        g.strokeRect(b.x, b.y, b.w, b.h);
        g.setLineDash([]);
      }
    }
    g.globalAlpha = 1;
  }

  /**
   * LOD 的边：按类型合并成一条 Path，一次 stroke。
   * 全览时 1 万条边既看不清类型也拖慢帧（LOD 单帧约 11ms，其中大半是边）。
   * 优先级：取代 > 支持 > 阻碍 > 其他 —— 保留最有结构含义的那批。
   * allowed 非 null 时只画两端都在集合里的边（焦点过滤要和点一致）。
   */
  private drawLodEdges(g: CanvasRenderingContext2D, inp: RenderInput, allowed: Set<string> | null): void {
    const { lib, vp } = inp;
    const view = {
      x: -vp.tx / vp.scale - 400, y: -vp.ty / vp.scale - 400,
      w: inp.width / vp.scale + 800, h: inp.height / vp.scale + 800,
    };
    const byType = new Map<string, { color: string; path: Path2D }>();
    // 边数超限时按关系重要性截断，但排序结果要缓存 —— 每帧重排 1 万条比画它们还贵
    if (!this.lodEdgeCache || this.lodEdgeCache.n !== lib.edges.length) {
      this.lodEdgeCache = { n: lib.edges.length, rev: lib.edges.length, edges: (topEdges(lib)?.edges ?? lib.edges) };
    }
    const budget = this.lodEdgeCache.edges;
    for (const e of budget) {
      if (allowed && !(allowed.has(e.fromId) && allowed.has(e.toId))) continue;
      // 一次查找同时拿到包围盒（裁剪）和锚点（画线），避免翻倍取数
      const ba = this.geo.box(e.fromId), bb = this.geo.box(e.toId);
      if (!ba || !bb) continue;
      if (!overlaps(ba, view) && !overlaps(bb, view)) continue;
      const pts = anchorPoints(ba, bb);
      let slot = byType.get(e.type);
      if (!slot) { slot = { color: EDGE_TYPE_COLOR[e.type], path: new Path2D() }; byType.set(e.type, slot); }
      // LOD 下用直线代替贝塞尔：省掉 bezierCurveTo 的求值
      slot.path.moveTo(pts.a.x, pts.a.y);
      slot.path.lineTo(pts.b.x, pts.b.y);
    }
    g.globalAlpha = 0.45;
    for (const { color, path } of byType.values()) {
      g.strokeStyle = color;
      g.lineWidth = 1 / vp.scale;
      g.stroke(path);
    }
    g.globalAlpha = 1;
  }

  /**
   * 概览卡片（LOD 里的「小规模」分支）。
   *
   * 为什么需要它：LOD 早期版本只画**实心色块**，一个字都不画 ——
   * 于是"自适应"到 30% 的视图就是一片橙色方块：看得见那儿有点，
   * 认不出那是什么。阶段一铺开（点按时间从左到右排开）必然落到这个缩放，
   * 于是「显示某个阶段的全部数据」= 显示一堆色块。
   *
   * 这里画真卡片 + **常驻屏幕字号**的标题：
   * 标题不随缩放变小，缩到 20% 也认得出每个点叫什么。
   * 节点数超过 LOD_CARD_MAX 就退回合并色块（1 万点的帧率红线）。
   */
  private drawLodCards(g: CanvasRenderingContext2D, inp: RenderInput, items: readonly { id: string }[]): void {
    const { vp } = inp;
    const p = pickPal(inp);
    const fs = LOD_LABEL_PX / vp.scale;     // 屏幕恒定 11px
    const barW = 4 / vp.scale;               // 类型色条 4 屏幕px
    const pad = 6 / vp.scale;
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.font = `600 ${fs}px ${uiFont()}`;
    for (const it of items) {
      const n = this.nIdx.get(it.id);
      if (!n) continue;
      const s = Renderer.nodeSizeOf(n, this.sizeCache);
      // 卡片底 + 描边（浅色主题里卡片和背景几乎同色，描边是唯一的轮廓）
      g.globalAlpha = 1;
      g.fillStyle = p.card;
      roundRect(g, n.x, n.y, s.w, s.h, 8 / vp.scale); g.fill();
      g.strokeStyle = p.border;
      g.lineWidth = 1.2 / vp.scale;
      g.stroke();
      // 左侧类型色条
      g.fillStyle = NODE_TYPE_COLOR[n.type];
      roundRect(g, n.x, n.y, barW, s.h, 2 / vp.scale); g.fill();
      // 封面图角标（右上角 26×26 的方图，屏幕恒定尺寸）。
      // ⚠️ 为什么放角标而不是左边占一格：概览卡片存在的意义是
      //    「认得出每个点叫什么」。左边塞一张图，标题就只剩两个字（实测「杭..」）——
      //    那是本末倒置。而 25% 缩放下 26px 的图本来也看不清内容，
      //    角标足够表达"这个点有图"，想看清楚放大就行（≥45% 走精细路径，
      //    那里是 120px 的真缩略图）。
      let textX = n.x + barW + pad;
      // 标题的右边界：**先按卡片算，角标画完再往左收**。
      // ⚠️ 顺序反了的话，标题会从角标底下穿过去 ——
      //    实测「杭州E类…」的「类」被橙圆压住、省略号被吞掉。
      let titleRight = n.x + s.w - pad;
      const src = n.imageData ?? n.imageUrl;
      if (src) {
        const img = this.getImageOrLoad(src);
        const iw = n.imageW ?? img?.naturalWidth ?? 200;
        const ih = n.imageH ?? img?.naturalHeight ?? 200;
        // 角标边长（屏幕 px）**不能超过节点自己的屏幕高度** ——
        // 全览时节点只有 19px 高，26px 的角标会直接溢出卡片。
        const thPx = Math.max(6, Math.min(LOD_THUMB_PX, s.h * vp.scale * 0.7));
        const th = thPx / vp.scale;
        const tx = n.x + s.w - th - pad;
        const ty = n.y + (s.h - th) / 2;
        // 标题要让开角标占的那一块
        titleRight = tx - pad;
        g.save();
        g.beginPath();
        g.rect(tx, ty, th, th);
        g.clip();
        g.fillStyle = p.border;
        g.fillRect(tx, ty, th, th);
        if (img && img.naturalWidth > 0) {
          // 保持比例、居中裁剪成方图
          const k = Math.max(th / iw, th / ih);
          const dw = iw * k, dh = ih * k;
          try { g.drawImage(img, tx + (th - dw) / 2, ty + (th - dh) / 2, dw, dh); }
          catch { /* CORS：保持占位色 */ }
        }
        g.restore();
      }
      // 标题：常驻屏幕字号
      const title = (n.title ?? '').trim();
      if (!title) continue;
      const maxW = Math.max(4 / vp.scale, titleRight - textX);
      const text = ellipsize(title, fs, maxW);
      if (!text) continue;
      g.fillStyle = p.text;
      g.fillText(text, textX, n.y + s.h / 2);
    }
    g.textAlign = 'left';
  }

  /* ---------- 层 1：主题 / 阶段框 ---------- */
  private drawAreas(g: CanvasRenderingContext2D, inp: RenderInput): void {
    const { lib, focusThemeId } = inp;
    // 焦点主题 → 它和所有子主题都视为"选中态"高亮
    const selChain = focusThemeId ? new Set(themeChain(lib, focusThemeId).map((t) => t.id)) : null;

    // 分两路：非空主题画框+标签，空主题只画错开的 ghost 标签
    const labelRects: { x: number; y: number; w: number; h: number; text: string; color: string; alpha: number }[] = [];
    let emptyIdx = 0;

    for (const t of lib.themes) {
      const isSel = selChain?.has(t.id) ?? false;
      const isSelRoot = focusThemeId ? t.id === focusThemeId : false;
      const dim = !!focusThemeId && !isSel;
      const nodes = nodesInTheme(lib, t.id, false);

      if (!nodes.length) {
        const fontSize = 11 / inp.vp.scale;
        g.font = `600 ${fontSize}px ${uiFont()}`;
        const text = `${t.name} · ${i18n('空主题')}`;
        const m = g.measureText(text);
        const padX = 10 / inp.vp.scale;
        const lineH = (fontSize + 6) / inp.vp.scale;
        const lx = 0 + 16 / inp.vp.scale;
        const ly = -10 / inp.vp.scale - (emptyIdx + 1) * lineH;
        emptyIdx += 1;
        g.globalAlpha = 0.45;
        g.fillStyle = t.color;
        g.textBaseline = 'top';
        g.fillText(text, lx, ly);
        labelRects.push({ x: lx - padX/2, y: ly, w: m.width + padX, h: lineH, text, color: t.color, alpha: 0.45 });
        continue;
      }

      const box = this.themeBox(lib, t);
      g.globalAlpha = dim ? 0.35 : 1;

      g.fillStyle = t.color;
      g.globalAlpha = (dim ? 0.012 : isSel ? 0.05 : 0.022);
      roundRect(g, box.x, box.y, box.w, box.h, 20); g.fill();

      g.globalAlpha = dim ? 0.22 : 1;
      g.setLineDash([7, 6]);
      g.lineWidth = (isSelRoot ? 2 : 1) / inp.vp.scale;
      g.strokeStyle = t.color;
      g.stroke();
      g.setLineDash([]);

      const fontSize = 12 / inp.vp.scale;
      g.font = `600 ${fontSize}px ${uiFont()}`;
      const text = `${t.name} · ${i18n('主题')}`;
      const m = g.measureText(text);
      const padX = 12 / inp.vp.scale;
      const lineH = (fontSize + 6) / inp.vp.scale;
      const lx = box.x + 16 / inp.vp.scale;
      const ly = box.y + 12 / inp.vp.scale;
      const alpha = dim ? 0.35 : 0.95;
      labelRects.push({ x: lx - padX/2, y: ly - 2/inp.vp.scale, w: m.width + padX, h: lineH, text, color: t.color, alpha });
    }

    /* 焦点阶段：单独一个高亮框 */
    if (inp.focusStageId) {
      const s = lib.stages.find((x) => x.id === inp.focusStageId);
      if (s) {
        const nodes = nodesInStage(lib, s.id);
        if (nodes.length) {
          const box = this.stageBox(lib, s);
          g.fillStyle = s.color;
          g.globalAlpha = 0.06;
          roundRect(g, box.x, box.y, box.w, box.h, 20); g.fill();
          g.globalAlpha = 1;
          g.setLineDash([4, 4]);
          g.lineWidth = 1.5 / inp.vp.scale;
          g.strokeStyle = s.color;
          g.stroke();
          g.setLineDash([]);

          const fontSize = 12 / inp.vp.scale;
          g.font = `600 ${fontSize}px ${uiFont()}`;
          const dateStr = s.start || s.end ? `${s.start ?? '…'} → ${s.end ?? '…'}` : '';
          const text = `${s.name}${dateStr ? ' · ' + dateStr : ''} · ${i18n('阶段')}`;
          const m = g.measureText(text);
          const padX = 12 / inp.vp.scale;
          const lineH = (fontSize + 6) / inp.vp.scale;
          const lx = box.x + 16 / inp.vp.scale;
          const ly = box.y + 12 / inp.vp.scale;
          labelRects.push({ x: lx - padX/2, y: ly - 2/inp.vp.scale, w: m.width + padX, h: lineH, text, color: s.color, alpha: 0.95 });
        }
      }
    }

    // 标签避让：先按 y 排，已画的往下让位
    labelRects.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labelRects.length; i++) {
      let cur = labelRects[i]!;
      for (let j = 0; j < i; j++) {
        const prev = labelRects[j]!;
        if (cur.x < prev.x + prev.w && cur.x + cur.w > prev.x &&
            cur.y < prev.y + prev.h && cur.y + cur.h > prev.y) {
          cur.y = prev.y + prev.h + 2 / inp.vp.scale;
          j = -1;
        }
      }
    }

    for (const lr of labelRects) {
      g.globalAlpha = lr.alpha;
      g.fillStyle = lr.color;
      g.textBaseline = 'top';
      g.fillText(lr.text, lr.x + 6 / inp.vp.scale, lr.y + 2 / inp.vp.scale);
    }
    g.globalAlpha = 1;
  }

  private boxCache = new Map<string, Rect>();

  /** 主题包围盒 + padding。主题不存坐标，由直接成员节点推导 —— 保证主题永远包住它的点 */
  private themeBox(lib: Library, t: LifeTheme): Rect {
    const cached = this.boxCache.get(t.id);
    if (cached) return cached;
    const nodes = nodesInTheme(lib, t.id, false);
    if (!nodes.length) return { x: 0, y: 0, w: 600, h: 400 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const s = Renderer.nodeSizeOf(n, this.sizeCache);
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + s.w); y1 = Math.max(y1, n.y + s.h);
    }
    const p = 28;
    const box = { x: x0 - p, y: y0 - p, w: x1 - x0 + p * 2, h: y1 - y0 + p * 2 };
    this.boxCache.set(t.id, box);
    return box;
  }

  /** 阶段包围盒：按时基 ∪ 显式成员节点推导 */
  private stageBox(lib: Library, s: LifeStage): Rect {
    const cached = this.boxCache.get(s.id);
    if (cached) return cached;
    const nodes = nodesInStage(lib, s.id);
    if (!nodes.length) return { x: 0, y: 0, w: 600, h: 400 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      const sz = Renderer.nodeSizeOf(n, this.sizeCache);
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + sz.w); y1 = Math.max(y1, n.y + sz.h);
    }
    const p = 28;
    const box = { x: x0 - p, y: y0 - p, w: x1 - x0 + p * 2, h: y1 - y0 + p * 2 };
    this.boxCache.set(s.id, box);
    return box;
  }

  /* ---------- 层 2/3：边与边标签 ---------- */
  private drawEdges(g: CanvasRenderingContext2D, inp: RenderInput): void {
    const { lib, vp } = inp;
    const showLabels = vp.scale > LABEL_SCALE;
    const view = { x: -vp.tx / vp.scale - 200, y: -vp.ty / vp.scale - 200, w: inp.width / vp.scale + 400, h: inp.height / vp.scale + 400 };
    const pal = pickPal(inp);
    this.geo.ensure(lib, graphRevision());

    for (const e of lib.edges) {
      // 视口裁剪：两端包围盒都不相交，整条边不可见
      const ba = this.geo.box(e.fromId), bb = this.geo.box(e.toId);
      if (!ba || !bb) continue;
      if (!overlaps(ba, view) && !overlaps(bb, view)) continue;
      const c = this.geo.curve(e);
      if (!c) continue;
      const touching = inp.hits.has(e.fromId) && inp.hits.has(e.toId);
      const lit = inp.ctxSet.has(e.fromId) && inp.ctxSet.has(e.toId);
      if (inp.searchActive && !lit && !touching) continue;
      const isHover = inp.hoverEdgeId === e.id;
      const isSel = inp.selectedEdgeId === e.id;
      this.strokeEdge(g, e.type, c, e.note, {
        scale: vp.scale,
        width: isSel ? 3 : isHover ? 2.8 : touching ? 2.6 : lit ? 2 : 1.5,
        alpha: isSel || isHover ? 1 : (inp.searchActive && !lit && !touching ? 0.12 : (lit || !inp.searchActive ? 0.9 : 0.55)),
        label: showLabels, arrow: true,
        selected: isSel,
      }, pal);
      // hover / 选中 → 线上标出这条线是什么类型
      if (isHover || isSel) this.drawEdgeBadge(g, e.type, c, pal, isSel, vp.scale);
    }

    // 派生的"属于"边（不存储，§5.2）—— 主题/阶段
    if (showLabels) {
      for (const { fromId, toId } of derivedThemeBelongEdges(lib)) {
        const c = this.curveBetween(fromId, toId);
        if (!c) continue;
        this.strokeEdge(g, 'belong', c, undefined, {
          scale: vp.scale, width: 1, alpha: 0.4, label: false, arrow: false, dashed: true,
        }, pal);
      }
      for (const { fromId, toId } of derivedStageBelongEdges(lib)) {
        const c = this.curveBetween(fromId, toId);
        if (!c) continue;
        this.strokeEdge(g, 'belong', c, undefined, {
          scale: vp.scale, width: 1, alpha: 0.35, label: false, arrow: false, dashed: true,
        }, pal);
      }
    }
  }

  /** 两个实体之间的曲线（派生边用 —— 它们不在 lib.edges 里） */
  private curveBetween(fromId: string, toId: string, offset = 0): EdgeCurve | null {
    const a = this.geo.box(fromId);
    const b = this.geo.box(toId);
    if (!a || !b) return null;
    return edgeCurve(a, b, offset);
  }

  /**
   * 线上贴着画一个类型徽标。
   *
   * 为什么需要：一条线是什么关系，光看颜色不够（八种类型里有好几种颜色很近），
   * 而"不同的连线不好操作"的根子就是**分不清哪条是哪条**。
   */
  private drawEdgeBadge(
    g: CanvasRenderingContext2D, type: EdgeType, c: EdgeCurve,
    pal: typeof PAL.normal | typeof PAL.high | typeof PAL.light,
    selected: boolean, scale: number,
  ): void {
    const fs = 10.5 / scale;
    const text = edgeTypeLabel(type);
    const tw = measure(text, fs) + 14 / scale;
    const th = fs * 1.75;
    const x = c.mid.x, y = c.mid.y;
    g.globalAlpha = 1;
    g.fillStyle = selected ? pal.accent : pal.card;
    roundRect(g, x - tw / 2, y - th / 2, tw, th, 5 / scale);
    g.fill();
    g.strokeStyle = selected ? pal.accent : EDGE_TYPE_COLOR[type];
    g.lineWidth = 1 / scale;
    g.stroke();
    g.fillStyle = selected ? pal.bg : EDGE_TYPE_COLOR[type];
    g.font = `500 ${fs}px ${uiFont()}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x, y);
    g.textAlign = 'left';
    g.globalAlpha = 1;
  }

  private strokeEdge(
    g: CanvasRenderingContext2D, type: EdgeType, c: EdgeCurve,
    note: string | undefined, o: { scale: number; width: number; alpha: number; label: boolean; arrow: boolean; dashed?: boolean; danger?: boolean; selected?: boolean },
    pal: typeof PAL.normal | typeof PAL.high | typeof PAL.light,
  ): void {
    const color = o.danger ? '#e06a6a'
      : o.selected ? pal.accent
      : (type === 'belong' ? pal.faint : EDGE_TYPE_COLOR[type]);

    g.globalAlpha = o.alpha;
    g.strokeStyle = color;
    g.lineWidth = o.width / o.scale;
    if (o.dashed) g.setLineDash([5 / o.scale, 5 / o.scale]);
    g.beginPath();
    g.moveTo(c.a.x, c.a.y);
    g.bezierCurveTo(c.c1.x, c.c1.y, c.c2.x, c.c2.y, c.b.x, c.b.y);
    g.stroke();
    g.setLineDash([]);

    // 箭头跟着曲线终点的切线走 —— 目标在左边时箭头朝左，不会插进节点里
    if (o.arrow) this.arrow(g, c.tip.x, c.tip.y, c.dir, o.scale, color, o.alpha);

    if (o.label && note) {
      const mx = c.mid.x, my = c.mid.y;
      const fs = 10 / o.scale;
      const tw = measure(note, fs) + 12 / o.scale;
      g.globalAlpha = 1;
      g.fillStyle = pal.bg;
      roundRect(g, mx - tw / 2, my - fs, tw, fs * 1.9, 5 / o.scale); g.fill();
      g.strokeStyle = EDGE_TYPE_COLOR[type];
      g.globalAlpha = 0.5;
      g.lineWidth = 1 / o.scale;
      g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = EDGE_TYPE_COLOR[type];
      g.font = `${fs}px "JetBrains Mono", ui-monospace, monospace`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(note, mx, my - fs * 0.05);
      g.textAlign = 'left';
    }
  }

  /** 箭头：尖端在 (x,y)，方向 dir（单位向量） */
  private arrow(g: CanvasRenderingContext2D, x: number, y: number, dir: { x: number; y: number }, s: number, color: string, alpha: number): void {
    const r = 5 / s;
    const px = -dir.y, py = dir.x;
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - r * 1.7 * dir.x + px * r, y - r * 1.7 * dir.y + py * r);
    g.lineTo(x - r * 1.7 * dir.x - px * r, y - r * 1.7 * dir.y - py * r);
    g.closePath();
    g.fill();
  }

  /* ---------- 层 4/5：节点 ---------- */
  private drawNodes(g: CanvasRenderingContext2D, inp: RenderInput): void {
    const { lib, vp, index } = inp;
    const view = {
      x: -vp.tx / vp.scale - 300, y: -vp.ty / vp.scale - 300,
      w: inp.width / vp.scale + 600, h: inp.height / vp.scale + 600,
    };
    const items = index.query(view);
    const fs = 13.5 / vp.scale;

    for (const it of items) {
      const n = lib.nodes.find((x) => x.id === it.id);
      if (!n) continue;
      if (inp.nodeTypes && inp.nodeTypes.size && !inp.nodeTypes.has(n.type)) continue;
      // 多维焦点：themeId / stageId 任一设了都参与过滤
      if (inp.focusThemeId && !inTheme(lib, n, inp.focusThemeId)) continue;
      if (inp.focusStageId && !inStage(lib, n, inp.focusStageId)) continue;
      if (inp.lens.size && !inp.lens.has(n.id)) continue;
      if (inp.searchActive && !inp.ctxSet.has(n.id) && !inp.hits.has(n.id)) continue;
      this.drawNode(g, n, inp, fs);
    }
  }

  private drawNode(g: CanvasRenderingContext2D, n: LifeNode, inp: RenderInput, fs: number): void {
    const p = pickPal(inp);
    const s = Renderer.nodeSizeOf(n, this.sizeCache);
    // LOD：缩到一定程度后文字和描边是纯浪费，fillText 占全部耗时的绝大部分
    const sc = inp.vp.scale;
    if (sc < 0.12) {
      g.globalAlpha = 0.9;
      g.fillStyle = NODE_TYPE_COLOR[n.type];
      g.fillRect(n.x, n.y, s.w, s.h);
      g.globalAlpha = 1;
      return;
    }
    const showText = sc >= 0.4;
    const isSel = inp.selected.has(n.id);
    const isHit = inp.hits.has(n.id);
    const isHover = inp.hovered === n.id;
    const legal = inp.linking?.valid.has(n.id) ?? false;
    const invalid = !!inp.linking && !legal;

    g.globalAlpha = invalid ? 0.22 : 1;

    if (isHit) {
      g.strokeStyle = p.accent; g.lineWidth = 2.5 / inp.vp.scale;
      roundRect(g, n.x - 5 / inp.vp.scale, n.y - 5 / inp.vp.scale, s.w + 10 / inp.vp.scale, s.h + 10 / inp.vp.scale, 15 / inp.vp.scale);
      g.stroke();
    }
    if (legal) {
      g.strokeStyle = p.ok; g.lineWidth = 2 / inp.vp.scale;
      roundRect(g, n.x - 3 / inp.vp.scale, n.y - 3 / inp.vp.scale, s.w + 6 / inp.vp.scale, s.h + 6 / inp.vp.scale, 13 / inp.vp.scale);
      g.stroke();
    }

    g.fillStyle = isSel ? p.cardSel : p.card;
    roundRect(g, n.x, n.y, s.w, s.h, 10 / inp.vp.scale); g.fill();

    if (sc >= 0.24 || isSel || isHit) {
      g.strokeStyle = isSel || isHit ? NODE_TYPE_COLOR[n.type] : (isHover ? p.borderHover : p.border);
      g.lineWidth = (isSel || isHit ? 1.6 : (inp.contrast ? 2 : 1.2)) / inp.vp.scale;
      g.stroke();
    }

    // ★ 图卡：type='work' + 有图 ⇒ 图片铺满整块，标题压在下缘。
    //
    // 为什么单独一种形态：现在的封面图是"框左侧 ≤120px 的缩略图"，
    // 拉大节点也不会放大图片 —— "以图为主"的东西做不到。
    // 图卡是**形态**不是**空间**：同一个「作品」节点在哪儿都长这样，
    // 否则同一个点换个视图就变一个样，看的人会以为出了 bug。
    //
    // ⚠️ 只在这条**精细路径**上生效（缩放 ≥ 45%）：
    //    再缩下去走的是画布既有的 LOD 简化卡片（一个 26px 的图角标），
    //    那里所有带图的点一视同仁 —— 概览的意义是"认得出每个点叫什么"。
    const isImageCard = n.type === 'work' && !!(n.imageData ?? n.imageUrl);
    if (isImageCard) {
      this.drawImageCard(g, n, inp, s);
      // 连线手柄（图卡也要能拉线出去）
      if (inp.vp.scale > 0.4 && !inp.linking) {
        g.globalAlpha = 0.45;
        g.fillStyle = NODE_TYPE_COLOR[n.type];
        g.beginPath();
        g.arc(n.x + s.w + 1 / inp.vp.scale, n.y + s.h / 2, 6 / inp.vp.scale, 0, Math.PI * 2);
        g.fill();
      }
      // 缩放手柄（选中才有）
      if (isSel) this.drawResizeHandle(g, n, s, inp);
      g.globalAlpha = 1;
      return;
    }

    // 左侧类型色条
    if (sc >= 0.24) {
      g.fillStyle = NODE_TYPE_COLOR[n.type];
      roundRect(g, n.x, n.y, 3.5 / inp.vp.scale, s.h, 2 / inp.vp.scale); g.fill();
    }

    if (!showText) { g.globalAlpha = 1; return; }

    /* 封面图：左侧缩略图（最大 120px 宽，保持 aspect），标题从图右边开始
     * - imageData 优先（持久化、加密）
     * - imageUrl 兜底（外链、零体积、不持久）
     * 加载失败/未完成时降级为占位底色 */
    let textXOff = 14;
    const THUMB_MAX = 120;
    const src = n.imageData ?? n.imageUrl;
    if (src) {
      const img = this.getImageOrLoad(src);
      // 取图比例：dataURL 模式用存好的 w/h；URL 模式从 naturalWidth 取
      const w = n.imageW ?? img?.naturalWidth ?? 200;
      const h = n.imageH ?? img?.naturalHeight ?? 200;
      const maxW = s.w >= 320 ? THUMB_MAX : s.w >= 260 ? 100 : 80;
      const tw = Math.min(maxW, w);
      const th = Math.round(tw * (h / w));
      const tx = n.x + 14 / inp.vp.scale;
      const ty = n.y + (s.h - th) / 2;
      g.fillStyle = p.border;
      g.fillRect(tx, ty, tw, th);
      if (img && img.naturalWidth > 0) {
        try { g.drawImage(img, tx, ty, tw, th); } catch { /* 跨域/CORS：保持占位色 */ }
      }
      textXOff = 14 + tw + 10;
    }

    const lines = this.layout.lines(n.id, n.title, s.w - textXOff - 10);
    g.textBaseline = 'top';
    g.fillStyle = n.done ? p.faint : p.text;
    g.font = `500 ${fs}px ${uiFont()}`;
    lines.forEach((l, i) => {
      const ty = n.y + 13 / inp.vp.scale + i * (fs + 4.5);
      g.fillText(l, n.x + textXOff / inp.vp.scale, ty);
      // 划掉文字（按实际渲染宽度走 —— fillText 后 measureText）
      if (n.done) {
        const m = g.measureText(l);
        const w = Math.min(m.width, s.w - textXOff - 14);
        const yMid = ty + fs * 0.55;
        g.save();
        g.strokeStyle = p.faint;
        g.lineWidth = 1.2 / inp.vp.scale;
        g.beginPath();
        g.moveTo(n.x + textXOff / inp.vp.scale, yMid);
        g.lineTo(n.x + textXOff / inp.vp.scale + w, yMid);
        g.stroke();
        g.restore();
      }
    });

    const subY = n.y + 13 / inp.vp.scale + lines.length * (fs + 4.5) + 4 / inp.vp.scale;
    const linkTag = n.linkUrl ? ' · 🔗' : '';
    const sub = (n.type === 'goal'
      ? `${nodeTypeLabel('goal')} · ${n.status ? statusLabel(n.status) : i18n('无目标')}${n.time ? ' · ' + n.time : ''}`
      : `${nodeTypeLabel(n.type)}${n.time ? ' · ' + n.time : ''}`) + linkTag;
    g.fillStyle = n.status ? (STATUS_COLOR[n.status] ?? p.faint) : p.faint;
    g.font = `${11 / inp.vp.scale}px "JetBrains Mono", ui-monospace, monospace`;
    g.fillText(sub, n.x + textXOff / inp.vp.scale, subY);

    // 连线手柄
    if (inp.vp.scale > 0.4 && !inp.linking) {
      g.globalAlpha = 0.45;
      g.fillStyle = NODE_TYPE_COLOR[n.type];
      g.beginPath();
      g.arc(n.x + s.w + 1 / inp.vp.scale, n.y + s.h / 2, 6 / inp.vp.scale, 0, Math.PI * 2);
      g.fill();
    }
    // 缩放手柄（选中才有）
    if (isSel) this.drawResizeHandle(g, n, s, inp);
    g.globalAlpha = 1;
  }

  /* ---------- 图卡 ---------- */

  /**
   * 图卡：图片铺满整块，标题压在下缘的一条暗带上。
   *
   * - **cover 裁切**：铺满整块，多出来的裁掉 —— 不留黑边。
   * - 图片没解开时画占位底色（跟封面图一个规矩）。
   * - 标题用白字压在暗带上：不压暗就看不清字。
   */
  private drawImageCard(g: CanvasRenderingContext2D, n: LifeNode, inp: RenderInput, s: { w: number; h: number }): void {
    const p = pickPal(inp);
    const src = (n.imageData ?? n.imageUrl)!;
    const img = this.getImageOrLoad(src);
    const iw = n.imageW ?? img?.naturalWidth ?? 0;
    const ih = n.imageH ?? img?.naturalHeight ?? 0;

    g.save();
    roundRect(g, n.x, n.y, s.w, s.h, 10 / inp.vp.scale);
    g.clip();
    if (img && img.naturalWidth > 0 && iw > 0 && ih > 0) {
      const k = Math.max(s.w / iw, s.h / ih);       // cover：小的那个边贴满
      const dw = iw * k, dh = ih * k;
      try { g.drawImage(img, n.x + (s.w - dw) / 2, n.y + (s.h - dh) / 2, dw, dh); }
      catch { /* CORS：保持占位色 */ }
    } else {
      g.fillStyle = p.border;
      g.fillRect(n.x, n.y, s.w, s.h);
    }
    // 下缘暗带：标题得读得出来
    const barH = Math.min(s.h * 0.5, 46 / inp.vp.scale);
    const grad = g.createLinearGradient(0, n.y + s.h - barH, 0, n.y + s.h);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.78)');
    g.fillStyle = grad;
    g.fillRect(n.x, n.y + s.h - barH, s.w, barH);
    g.restore();

    // 标题：一行白字
    const fs = 14 / inp.vp.scale;
    const lines = this.layout.lines(n.id, n.title, s.w - 6, 13.5, 1);
    g.textBaseline = 'bottom';
    g.fillStyle = '#ffffff';
    g.font = `600 ${fs}px ${uiFont()}`;
    g.fillText(lines[0] ?? '', n.x + 12 / inp.vp.scale, n.y + s.h - 10 / inp.vp.scale);
    g.textBaseline = 'top';
  }

  /**
   * 缩放手柄：选中节点右下角一个小方块（屏幕恒定 9px）。
   *
   * 为什么图卡必须有它：图卡的全部意义是"以图为主" ——
   * 节点不能拉大，图就永远只有那么大一块。
   */
  private drawResizeHandle(g: CanvasRenderingContext2D, n: LifeNode, s: { w: number; h: number }, inp: RenderInput): void {
    if (inp.vp.scale < 0.4) return;
    const size = 9 / inp.vp.scale;
    const p = pickPal(inp);
    const hx = n.x + s.w - size / 2;
    const hy = n.y + s.h - size / 2;
    g.fillStyle = p.card;
    g.fillRect(hx, hy, size, size);
    g.strokeStyle = p.borderHover;
    g.lineWidth = 1.4 / inp.vp.scale;
    g.strokeRect(hx, hy, size, size);
  }

  /* ---------- 层 6：屏幕层叠加 ---------- */
  private drawOverlay(g: CanvasRenderingContext2D, inp: RenderInput): void {
    const p = pickPal(inp);
    const { vp } = inp;
    if (inp.linking) {
      const a = this.geo.box(inp.linking.fromId);
      if (a) {
        // 预览线用**和真正那条边一样的几何**：从源点朝向光标的那一侧出，
        // 曲率、锚点全都一致 —— 松手之前看到的形状就是落地的形状。
        const wx = (inp.linking.sx - vp.tx) / vp.scale;
        const wy = (inp.linking.sy - vp.ty) / vp.scale;
        const cur = edgeCurve(a, { x: wx, y: wy, w: 0, h: 0 }, 0);
        const P = (q: { x: number; y: number }): [number, number] =>
          [q.x * vp.scale + vp.tx, q.y * vp.scale + vp.ty];
        const [x1, y1] = P(cur.a);
        const [cx1, cy1] = P(cur.c1);
        const [cx2, cy2] = P(cur.c2);
        const [x2, y2] = P(cur.b);
        g.save();
        g.strokeStyle = EDGE_TYPE_COLOR[inp.linking.type];
        g.lineWidth = 2;
        g.setLineDash([6, 5]);
        g.beginPath(); g.moveTo(x1, y1); g.bezierCurveTo(cx1, cy1, cx2, cy2, x2, y2); g.stroke();
        g.setLineDash([]);
        g.restore();
      }
    }
    if (inp.marquee) {
      const [x, y] = worldToScreen(vp, inp.marquee.x, inp.marquee.y);
      const w = inp.marquee.w * vp.scale, h = inp.marquee.h * vp.scale;
      g.fillStyle = p.accentSoft;
      g.strokeStyle = p.accent;
      g.lineWidth = 1;
      g.fillRect(x, y, w, h);
      g.strokeRect(x, y, w, h);
    }
  }

  /** 迷你地图（屏幕右下角） */
  drawMinimap(g: CanvasRenderingContext2D, w: number, h: number, inp: RenderInput): void {
    const p = pickPal(inp);
    const { lib, vp } = inp;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of lib.nodes) {
      const s = Renderer.nodeSize(n);
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + s.w); y1 = Math.max(y1, n.y + s.h);
    }
    if (!isFinite(x0)) return;
    const pad = 200;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    const k = Math.min(w / (x1 - x0), h / (y1 - y0));
    const ox = (w - (x1 - x0) * k) / 2, oy = (h - (y1 - y0) * k) / 2;
    const P = (x: number, y: number): [number, number] => [(x - x0) * k + ox, (y - y0) * k + oy];

    g.clearRect(0, 0, w, h);
    const mmEdges = new Map<string, { color: string; path: Path2D }>();
    for (const e of lib.edges) {
      const a = this.nIdx.get(e.fromId), b = this.nIdx.get(e.toId);
      if (!a || !b) continue;
      const [ax, ay] = P(a.x + a.w / 2, a.y + a.h / 2);
      const [bx, by] = P(b.x + b.w / 2, b.y + b.h / 2);
      let slot = mmEdges.get(e.type);
      if (!slot) { slot = { color: EDGE_TYPE_COLOR[e.type], path: new Path2D() }; mmEdges.set(e.type, slot); }
      slot.path.moveTo(ax, ay); slot.path.lineTo(bx, by);
    }
    g.globalAlpha = 0.3; g.lineWidth = 0.6;
    for (const { color, path } of mmEdges.values()) { g.strokeStyle = color; g.stroke(path); }
    g.globalAlpha = 1;
    // 点同样合批，避免 1 万次 fillRect + 1 万次 fillStyle 切换
    const byType = new Map<string, { color: string; path: Path2D }>();
    for (const n of lib.nodes) {
      const s = Renderer.nodeSize(n);
      const [px, py] = P(n.x, n.y);
      let slot = byType.get(n.type);
      if (!slot) { slot = { color: NODE_TYPE_COLOR[n.type], path: new Path2D() }; byType.set(n.type, slot); }
      slot.path.rect(px, py, Math.max(1, s.w * k), Math.max(1, s.h * k));
    }
    g.globalAlpha = 0.85;
    for (const { color, path } of byType.values()) { g.fillStyle = color; g.fill(path); }
    g.globalAlpha = 1;
    const [vx, vy] = P(-vp.tx / vp.scale, -vp.ty / vp.scale);
    g.strokeStyle = p.accent; g.globalAlpha = 0.55; g.lineWidth = 1;
    g.strokeRect(vx, vy, (inp.width / vp.scale) * k, (inp.height / vp.scale) * k);
    g.globalAlpha = 1;
  }
}

const edgePriority = (e: { type: string }): number =>
  e.type === 'replace' ? 0 : e.type === 'support' ? 1 : e.type === 'block' ? 2 : e.type === 'cause' ? 3 : 5;

/** 规模不超阈值就不截断，省掉全部排序开销 */
function topEdges(lib: Library): { edges: readonly import('../model/types').LifeEdge[] } | null {
  if (lib.edges.length <= LOD_EDGE_MAX) return { edges: lib.edges };
  return { edges: [...lib.edges].sort((a, b) => edgePriority(a) - edgePriority(b)).slice(0, LOD_EDGE_MAX) };
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

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
