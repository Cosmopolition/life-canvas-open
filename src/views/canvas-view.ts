/**
 * 画布视图（视图一）。手势、渲染循环、迷你地图。
 */
import {
  EDGE_TYPES, EDGE_TYPE_COLOR, edgeTypeLabel,
  MIN_NODE_H, MIN_NODE_W,
  canConnect, type EdgeType, type EntityKind, type Library, type LifeNode, type NodeType,
} from '../model/types';
import { Renderer, type RenderInput } from '../canvas/renderer';
import { GridIndex } from '../canvas/spatial-index';
import { EdgeGeometry } from '../canvas/edge-geometry';
import { graphRevision } from '../model/selectors';
import { el } from '../ui/dom';
import { t } from '../i18n';
import {
  clampScale, fitTo, screenToWorld, zoomAt, type Rect, type Viewport,
} from '../canvas/viewport';

export interface CanvasHost {
  lib: Library;
  /** @deprecated 旧单焦点；过渡期由 app 层用 focusThemeId 兜底。CanvasView 读新字段。 */
  areaId: string | null;
  /** 主题焦点：双焦点之一 */
  focusThemeId: string | null;
  /** 阶段焦点：双焦点之一 */
  focusStageId: string | null;
  /**
   * 不画主题 / 阶段的框与标签（周画布用）。
   *
   * 周画布是"这一周的复盘"，不是主画布那张主题地图 ——
   * 把全局主题框搬进来只会让人以为"这一周也有阶段面"。
   */
  hideAreas: boolean;
  nodeTypes: ReadonlySet<NodeType> | null;
  selected: Set<string>;
  hits: Set<string>;
  ctxSet: Set<string>;
  searchActive: boolean;
  contrast: boolean;
  theme: 'dark' | 'light';
  /** 当前筛选透镜内的点；不在其中的点在画布上压暗 */
  lens: readonly LifeNode[];
  onSelect(ids: string[]): void;
  onMove(id: string, x: number, y: number, done: boolean, resize?: { w: number; h: number }): void;
  onCreate(x: number, y: number): void;
  onLink(from: { id: string; kind: EntityKind; type?: NodeType }, toId: string, type: EdgeType): void;
  /**
   * 删除一条边。
   *
   * ⚠️ 确认框由**调用方**（app 层）负责 —— 画布不自己弹 window.confirm：
   *    原生壳里 WKWebView 没有实现 alert 面板，window.confirm 会**直接返回取消**，
   *    删除按钮点了等于没点。这里统一走 app 的 confirmBox。
   */
  onRemoveEdge(id: string): void;
  /** 当前选中的边（画布上高亮 + 浮出操作条） */
  selectedEdgeId: string | null;
  /** 选中 / 取消选中一条边 */
  onSelectEdge(id: string | null): void;
  /** 打开「编辑关系」面板 */
  onEditEdge(id: string): void;
  /** 切换当前连线类型（拖线时改，图例里也用它） */
  setEdgeType(type: EdgeType): void;
  /** 双击 goal / action 节点 → 进入详情画布（栈式 push）。可选；旧 host 不传不崩 */
  onEnterDetail?: (id: string) => void;
  onRequestReason(title: string, prefill?: string): Promise<string | null>;
  getEdgeType(): EdgeType;
  onPerf(ms: number, frameGap: number): void;
}

export class CanvasView {
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private mm: HTMLCanvasElement;
  private mmCtx: CanvasRenderingContext2D;
  private renderer = new Renderer();
  private index = new GridIndex();
  private vp: Viewport = { tx: 0, ty: 0, scale: 1 };
  private host: CanvasHost;

  private hover: string | null = null;
  /** 当前 hover 的边 id（鼠标下方） */
  private hoverEdge: string | null = null;
  private pan: { x: number; y: number } | null = null;
  private dragNode: { id: string; dx: number; dy: number; moved: boolean } | null = null;
  /**
   * 正在拉的那个角（缩放节点大小）。
   *
   * 图卡的全部意义是"以图为主" —— 节点不能拉大，图就永远只有那么大一块。
   */
  private dragResize: { id: string; x: number; y: number; w: number; h: number } | null = null;
  /**
   * 正在拉的线。
   *
   * ⚠️ type 放在这里（而不是每次问 host）：拖线途中要能改类型，
   *    改完**合法目标集合也要跟着重算** —— 否则会出现
   *    「把「取代」改成「冲突」之后，还按旧的约束高亮着目标」。
   */
  private link: { fromId: string; sx: number; sy: number; type: EdgeType; valid: Set<string> } | null = null;
  /** 类型选择面板打开时：这一次 mouseup 不该把线连出去 */
  private linkMenuOpen = false;
  private marquee: Rect | null = null;
  private raf = 0;
  private dirty = true;
  private lastFrame = 0;
  private lastMM = 0;
  /** 正在跑的视口补间（fit 的 300ms）。新的视口操作要先把它停掉。 */
  private vpAnim = 0;

  /** 连线几何（和 renderer 共用同一份规则） */
  private geo = new EdgeGeometry();
  /** 选中边时浮在边上的小操作条 */
  private edgeBar: HTMLElement;
  /** 拖线时跟着光标的类型徽标 */
  private linkBadge: HTMLElement;
  /** 拖线时的类型选择面板 */
  private linkMenu: HTMLElement | null = null;

  private dpr = 1;
private ro: ResizeObserver | null = null;

  constructor(cv: HTMLCanvasElement, mm: HTMLCanvasElement, host: CanvasHost) {
    this.cv = cv; this.mm = mm; this.host = host;
    const c = cv.getContext('2d', { alpha: false });
    const m = mm.getContext('2d');
    if (!c || !m) throw new Error(t('error.no2dContext'));
    this.ctx = c; this.mmCtx = m;
    // ⚠️ 浮层**必须先于 resize() 建好**：
    //    resize() 末尾会调 render()，render() 里要同步浮层位置。
    //    浮层还没建就 render → this.edgeBar 是 undefined → 构造函数抛错 →
    //    整个 app 起不来（而且报的是 "Cannot set properties of undefined"，
    //    跟"浮层"八竿子打不着，最难查的那种）。
    this.edgeBar = this.buildEdgeBar();
    this.linkBadge = this.buildLinkBadge();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // 栅格列一变（断点切换、侧栏抽屉开合、原生外壳模式切换）不会触发
    // window.resize，而后备存储尺寸只在 resize() 里设 —— 没有观察者画布就会
    // 一直用旧尺寸绘制，表现为拉伸 / 模糊。
    if (typeof ResizeObserver !== 'undefined') {
      const host = cv.parentElement;
      if (host) {
        this.ro = new ResizeObserver(() => this.resize());
        this.ro.observe(host);
      }
    }
    this.bind();
    // 图片 decode 完 → 再画一帧。
    // 不接这个的话：贴图那一帧图还没 decode 完（画占位底色），
    // 之后再没人重绘 → **图永远显示不出来**（右栏看得到，画布上永远没有）。
    this.renderer.setImageLoadedHandler(() => this.invalidate());
    this.lastFrame = 0;
    this.raf = requestAnimationFrame(this.loop);
  }

  invalidate(): void { this.dirty = true; }

  /** 当场重绘一帧，不等 rAF。 */
  renderNow(): void { this.dirty = false; this.render(); }

  /** 这张图解开了吗（自测 / 截图用）。见 renderer.isImageReady。 */
  imageReady(src: string): boolean { return this.renderer.isImageReady(src); }

  /**
   * 某条边中点的屏幕坐标（client 坐标系）。
   *
   * 自测 / 截图用：想"点到那条线"，得知道它现在画在哪儿 ——
   * 而且必须用**同一份几何**算，否则点的是"以为在那儿"的位置。
   */
  edgeScreenPoint(edgeId: string): { x: number; y: number } | null {
    const c = this.curveOf(edgeId);
    if (!c) return null;
    const r = this.cv.getBoundingClientRect();
    return {
      x: r.left + c.mid.x * this.vp.scale + this.vp.tx,
      y: r.top + c.mid.y * this.vp.scale + this.vp.ty,
    };
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.cv.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * this.dpr));
    const h = Math.max(1, Math.round(r.height * this.dpr));
    // 尺寸没变就别碰后备存储 —— 一碰就清空。
    if (this.cv.width === w && this.cv.height === h) return;
    this.cv.width = w;
    this.cv.height = h;
    this.dirty = true;
    // ⚠️ 设置 cv.width 会**清空画布**（位图没了，不是变模糊）。
    //    只置 dirty 不够：下一帧来之前画布是**空白**的 ——
    //    而窗口在后台 / 被遮挡时 rAF 会被节流，那一帧可能迟迟不来，
    //    于是画布一直空着（画面上什么都没有，缩放读数却完全正常，
    //    很容易被当成"数据没了"）。
    //    所以这里当场重绘一次：多画一帧，换"永远不会空白"。
    this.render();
  }

  private get size(): { w: number; h: number } {
    return { w: this.cv.width / this.dpr, h: this.cv.height / this.dpr };
  }

  /**
   * 当前画布的 **CSS** 尺寸（fitTo 要的就是这个）。
   *
   * 不能直接用 `size`（后备存储 / dpr）：后备存储只在 resize() 里更新，
   * 而 resize() 是 ResizeObserver 驱动的 —— 布局刚变的那一帧它还是旧值。
   * 启动时定位画布正好撞上这个：原生外壳的 `data-native-shell` 刚设上，
   * 顶栏塌陷改了布局，后备存储还没跟上 → fit 按旧尺寸算 → 缩放是错的。
   */
  private cssSize(): { w: number; h: number } {
    const r = this.cv.getBoundingClientRect();
    if (r.width > 1 && r.height > 1) return { w: r.width, h: r.height };
    return this.size;
  }

  /** 重建空间索引。只填 flat，网格留给首帧之后的空闲时间 */
  rebuildIndex(lib: Library): void {
    this.renderer.invalidateAll();
    const items = lib.nodes.map((n) => {
      const s = this.renderer.nodeSize(n);
      return { id: n.id, x: n.x, y: n.y, w: s.w, h: s.h };
    });
    this.index.setAll(items);
    this.dirty = true;
  }

  /** 更新单个节点位置，不重建整个索引（拖拽时用） */
  updateIndex(n: LifeNode): void {
    this.renderer.invalidateBoxes();
    const s = Renderer.nodeSize(n);
    this.index.insert({ id: n.id, x: n.x, y: n.y, w: s.w, h: s.h });
    this.dirty = true;
  }

  /**
   * 把一批点装进视口。
   *
   * minScale 是安全网（默认 0 = 不限）。低缩放时渲染器会走「概览卡片」分支，
   * 标题用常驻屏幕字号，缩到 20% 也认得出每个点 —— 所以 fit 可以放心地
   * 真的把数据装下，不必为了"看得清"而砍掉一部分内容。
   *
   * @returns 真的装下了才返回 true。点集为空 / 视口尺寸还是 0 时返回 false ——
   *          调用方据此知道"这次没定位成"，可以下次再来。
   */
  fit(ids?: string[], maxScale = 1.15, minScale = 0): boolean {
    const lib = this.host.lib;
    // ⚠️ 必须先停掉正在跑的补间 —— fit 自己也是 300ms 补间，每帧都改写 vp。
    //    两个补间同时跑时，后一个的起点(from)是上一个补间的**中途**位置，
    //    画面会先往旧目标冲一段再拐回来（"刚摆好又弹回去"）。
    //    重置会连续 fit（清焦点 + 回全局），正好撞上这个。
    this.cancelVpAnim();
    // ids 必须是 Set：用 Array.includes 在 filter 里找是 O(n²)，
    // 1 万节点实测 1.3 秒，全花在这里
    const want = ids ? new Set(ids) : null;
    const nodes = (want ? lib.nodes.filter((n) => want.has(n.id)) : lib.nodes).map((n) => {
      const s = Renderer.nodeSize(n);
      return { x: n.x, y: n.y, w: s.w, h: s.h };
    });
    const { w, h } = this.cssSize();
    const fitVp = fitTo(nodes, w, h, 78, maxScale, minScale);
    if (!fitVp) return false;
    const from = { ...this.vp };
    const t0 = performance.now();
    const dur = 300;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      this.vp = {
        tx: from.tx + (fitVp.tx - from.tx) * e,
        ty: from.ty + (fitVp.ty - from.ty) * e,
        scale: from.scale + (fitVp.scale - from.scale) * e,
      };
      this.dirty = true;
      if (p < 1) { this.vpAnim = requestAnimationFrame(step); } else { this.vpAnim = 0; }
    };
    this.vpAnim = requestAnimationFrame(step);
    return true;
  }

  /**
   * 停掉正在跑的视口补间。
   *
   * ⚠️ 为什么必须停：fit 的补间每一帧都改写 vp。
   *    如果在它还在跑的时候居中（centerOn）或缩放（zoom），
   *    下一帧就被它改回去 —— 症状是「刚摆好又跳回去」，
   *    而且是**偶发**的（取决于补间剩几帧），最难查的那种。
   */
  private cancelVpAnim(): void {
    if (this.vpAnim) { cancelAnimationFrame(this.vpAnim); this.vpAnim = 0; }
  }

  centerOn(id: string, scale = 1.15): void {
    const n = this.host.lib.nodes.find((x) => x.id === id);
    if (!n) return;
    this.cancelVpAnim();
    const s = Renderer.nodeSize(n);
    const { w, h } = this.cssSize();
    this.vp = { scale: clampScale(scale), tx: w / 2 - (n.x + s.w / 2) * scale, ty: h / 2 - (n.y + s.h / 2) * scale };
    this.dirty = true;
  }

  get viewport(): Viewport { return this.vp }
  setViewport(v: Viewport): void { this.cancelVpAnim(); this.vp = v; this.dirty = true; }

  /**
   * 把相机放到某个世界坐标上（空格 / 还没开始写的空间用）。
   *
   * 与 fit 的区别：fit 要有节点才装得下；空空间没有节点可 fit，
   * 但相机也得落到一个合理的地方 —— 否则用户进到一张空画布，
   * 眼前是上一次的视图，还以为"怎么什么都没有"。
   */
  panTo(x: number, y: number, scale = 1): void {
    this.cancelVpAnim();
    const { w, h } = this.cssSize();
    const s = clampScale(scale);
    this.vp = { scale: s, tx: w / 2 - x * s, ty: h / 2 - y * s };
    this.dirty = true;
  }

  zoom(f: number): void {
    this.cancelVpAnim();
    const { w, h } = this.size;
    this.vp = zoomAt(this.vp, w / 2, h / 2, f);
    this.dirty = true;
  }

  /* ---------- 手势 ---------- */

  private bind(): void {
    const c = this.cv;

    c.addEventListener('mousedown', (e) => this.onDown(e));
    c.addEventListener('dblclick', (e) => this.onDblClick(e));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', () => this.onUp());

    // 连线手柄
    //
    // ⚠️ 这里**不能**用 nodeAt 找节点：
    //    手柄圆点画在节点框**外面**一点（n.x + w + 1/scale），
    //    所以"照着圆点中心点"时 nodeAt 根本命中不到那个节点 →
    //    只有圆点压在框里的左半边能点。
    //    症状就是"那个圆点在那儿，我点了，没反应"。
    //    改成直接找**最近的手柄**，圆点整块都能点。
    c.addEventListener('mousedown', (e) => {
      // 手柄在低缩放时根本不画（renderer：scale > 0.4 才画）—— 那时也别开始拖线
      if (this.vp.scale <= 0.4) return;
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      const tol = 9 / this.vp.scale;   // 9 屏幕像素
      let best: LifeNode | null = null;
      let bestD = tol;
      for (const n of this.host.lib.nodes) {
        const s = Renderer.nodeSize(n);
        const hx = n.x + s.w + 1 / this.vp.scale;   // 和 renderer 画的同一个位置
        const hy = n.y + s.h / 2;
        const d = Math.hypot(wx - hx, wy - hy);
        if (d < bestD) { bestD = d; best = n; }
      }
      if (!best) return;
      e.stopPropagation();
      this.startLink(best, e);
    }, true);
  }

  private toWorld(cx: number, cy: number): [number, number] {
    const r = this.cv.getBoundingClientRect();
    return screenToWorld(this.vp, cx - r.left, cy - r.top);
  }

  private nodeAt(e: MouseEvent): string | null {
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    return this.index.hitTest(wx, wy)?.id ?? null;
  }

  /**
   * 找鼠标下方最近的边。
   *
   * ⚠️ 用的是**画出来的那条曲线**（edge-geometry 里和 renderer 共用的那份）。
   *    以前这里自己重算了一遍贝塞尔，两边只要差一个像素就是
   *    「鼠标明明指着线，却点不中」—— 而且代码看着完全正确。
   */
  private edgeAt(wx: number, wy: number): string | null {
    this.geo.ensure(this.host.lib, graphRevision());
    return this.geo.hitTest(this.host.lib, wx, wy, 7 / this.vp.scale);
  }

  /** 某条边的曲线（选中高亮 / 操作条定位用） */
  private curveOf(edgeId: string): ReturnType<EdgeGeometry['curve']> {
    this.geo.ensure(this.host.lib, graphRevision());
    const e = this.host.lib.edges.find((v) => v.id === edgeId);
    return e ? this.geo.curve(e) : null;
  }

  /**
   * 合法目标集合。类型一变就要重算 ——
   * 「取代」只能从目标出发，换成「冲突」就变成任意两点了。
   */
  private validTargets(type: EdgeType, from: LifeNode): Set<string> {
    const valid = new Set<string>();
    const fromKind = { kind: 'node' as const, type: from.type };
    if (canConnect(type, fromKind, 'node')) {
      for (const nd of this.host.lib.nodes) valid.add(nd.id);
    }
    // 目标也可以是主题 / 阶段
    if (canConnect(type, fromKind, 'theme')) {
      for (const th of this.host.lib.themes) valid.add(th.id);
    }
    if (canConnect(type, fromKind, 'stage')) {
      for (const s of this.host.lib.stages) valid.add(s.id);
    }
    return valid;
  }

  private startLink(n: LifeNode, e: MouseEvent): void {
    const type = this.host.getEdgeType();
    const r = this.cv.getBoundingClientRect();
    this.link = {
      fromId: n.id,
      sx: e.clientX - r.left,
      sy: e.clientY - r.top,
      type,
      valid: this.validTargets(type, n),
    };
    this.linkMenuOpen = false;
    this.dirty = true;
  }

  private onDown(e: MouseEvent): void {
    // 这一下是画布上的操作 —— 类型面板的"这一次松手不连线"作废
    this.linkMenuOpen = false;
    this.closeLinkMenu();
    // 中键或空格 = 平移；Shift = 框选；普通拖 = 平移
    if (e.button === 1) {
      this.pan = { x: e.clientX - this.vp.tx, y: e.clientY - this.vp.ty };
      return;
    }
    // 边优先：先试边，命中则不进入节点拖拽 / 框选流程
    {
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      const eid = this.edgeAt(wx, wy);
      if (eid) {
        // ⚠️ 点线 = **选中**，不是删除。
        //    以前"点一下就弹确认然后删"，于是：想改这条线的类型做不到，
        //    想删也随时可能误触（而且原生壳里那个确认框根本不弹，见 host 注释）。
        //    现在选中 → 边上浮出操作条 → 改 / 删都在那里，明明白白。
        this.host.onSelectEdge(eid);
        this.dirty = true;
        return;
      }
    }
    // 缩放手柄：选中节点的右下角。**先于节点拖拽判** ——
    // 手柄压在节点框里，不先判的话点它会变成"拖动整个节点"。
    const rz = this.resizeHandleAt(e);
    if (rz) {
      this.dragResize = rz;
      this.dirty = true;
      return;
    }
    const id = e.shiftKey ? null : this.nodeAt(e);
    const n = id ? this.host.lib.nodes.find((x) => x.id === id) : undefined;
    if (id && n) {
      // ⌘+点击 = 打开节点的 linkUrl（不是拖动起点）
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && n.linkUrl) {
        e.preventDefault();
        window.open(n.linkUrl, '_blank', 'noopener');
        return;
      }
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      this.dragNode = { id, dx: wx - n.x, dy: wy - n.y, moved: false };
      this.host.onSelect(e.ctrlKey || e.metaKey ? [...this.host.selected, id] : [id]);
      return;
    }
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    this.marquee = { x: wx, y: wy, w: 0, h: 0 };
    this.pan = { x: e.clientX - this.vp.tx, y: e.clientY - this.vp.ty };
    if (!e.ctrlKey && !e.metaKey) this.host.onSelect([]);
    this.dirty = true;
  }

  /**
   * 选中节点的右下角缩放手柄，鼠标在它上面吗？
   *
   * 只对**单个**选中的节点有手柄（多选时不知道该拉哪一个）。
   * 判定用世界坐标：手柄画在 (n.x+w, n.y+h) 那个角上，
   * 容差按屏幕像素算（7px），缩放多少都跟得上鼠标。
   */
  private resizeHandleAt(e: MouseEvent): { id: string; x: number; y: number; w: number; h: number } | null {
    if (this.vp.scale < 0.4) return null;
    const sel = [...this.host.selected];
    if (sel.length !== 1) return null;
    const n = this.host.lib.nodes.find((x) => x.id === sel[0]);
    if (!n) return null;
    const s = Renderer.nodeSize(n);
    const tol = 8 / this.vp.scale;
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    if (Math.abs(wx - (n.x + s.w)) > tol) return null;
    if (Math.abs(wy - (n.y + s.h)) > tol) return null;
    return { id: n.id, x: n.x, y: n.y, w: s.w, h: s.h };
  }

  /**
   * 缩放手柄命中判定（自测用）—— 返回命中的节点 id，没命中返回 null。
   *
   * 为什么单独开一个口：自测要模拟"抓住右下角往右下拖"，
   * 拖不动的时候得能分清是**没命中手柄**（点偏了 / 没选中）
   * 还是**命中了但拖了没反应**（逻辑坏了）—— 这两件事的修法完全不同。
   */
  resizeHandleAtPoint(clientX: number, clientY: number): string | null {
    const rz = this.resizeHandleAt({ clientX, clientY } as MouseEvent);
    return rz ? rz.id : null;
  }

  /** 这个点在**空间索引**里吗（自测用）—— 画布画点、点选点都靠它 */
  indexHas(id: string): boolean {
    return this.index.has(id);
  }

  private onMove(e: MouseEvent): void {
    this.lastMouse = e;
    if (this.pan) {
      this.vp.tx = e.clientX - this.pan.x;
      this.vp.ty = e.clientY - this.pan.y;
      this.dirty = true;
      if (this.marquee) {
        const [wx, wy] = this.toWorld(e.clientX, e.clientY);
        const x = this.marquee.x, y = this.marquee.y;
        this.marquee = { x: Math.min(x, wx), y: Math.min(y, wy), w: Math.abs(wx - x), h: Math.abs(wy - y) };
      }
      return;
    }
    if (this.dragNode) {
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      const nx = Math.round(wx - this.dragNode.dx), ny = Math.round(wy - this.dragNode.dy);
      this.host.onMove(this.dragNode.id, nx, ny, false);
      this.dragNode.moved = true;
      this.dirty = true;
      return;
    }
    if (this.dragResize) {
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      const w = Math.max(MIN_NODE_W, Math.round(wx - this.dragResize.x));
      const h = Math.max(MIN_NODE_H, Math.round(wy - this.dragResize.y));
      this.host.onMove(this.dragResize.id, this.dragResize.x, this.dragResize.y, false, { w, h });
      this.dirty = true;
      return;
    }
    if (this.link) {
      const r = this.cv.getBoundingClientRect();
      this.link.sx = e.clientX - r.left;
      this.link.sy = e.clientY - r.top;
      this.syncLinkBadge();
      this.dirty = true;
      return;
    }
    // 悬停
    const id = this.nodeAt(e);
    if (id !== this.hover) { this.hover = id; this.dirty = true; }
    // 边悬停（节点优先 —— 节点的拖拽手柄也在自己身上）
    const [hwx, hwy] = this.toWorld(e.clientX, e.clientY);
    const eid = id ? null : this.edgeAt(hwx, hwy);
    if (eid !== this.hoverEdge) { this.hoverEdge = eid; this.dirty = true; }
  }

  private lastMouse: MouseEvent | null = null;

  private onUp(): void {
    if (this.dragNode) {
      this.host.onMove(this.dragNode.id, 0, 0, true);
      this.dragNode = null;
    }
    if (this.dragResize) {
      this.host.onMove(this.dragResize.id, this.dragResize.x, this.dragResize.y, true);
      this.dragResize = null;
    }
    if (this.link) {
      // 类型面板开着的时候松手**不连线** —— 刚才那一下是去点面板的
      const drop = !this.linkMenuOpen;
      const id = drop && this.lastMouse ? this.nodeAt(this.lastMouse) : null;
      if (id && this.link.valid.has(id)) {
        const n = this.host.lib.nodes.find((x) => x.id === this.link!.fromId);
        // 用的是**这次拖线时选的类型**，不是全局图例里的当前类型
        if (n) this.host.onLink({ id: n.id, kind: 'node', type: n.type }, id, this.link.type);
      }
      this.link = null;
      this.linkMenuOpen = false;
      this.closeLinkMenu();
      this.dirty = true;
    }
    if (this.marquee && this.marquee.w > 4) {
      const ids = this.index.query(this.marquee).map((x) => x.id);
      this.host.onSelect(ids);
    }
    this.marquee = null;
    this.pan = null;
    this.dirty = true;
  }

  private onDblClick(e: MouseEvent): void {
    // 双击一条边 = 打开「编辑关系」（改类型 / 改备注 / 删）
    {
      const [wx, wy] = this.toWorld(e.clientX, e.clientY);
      const eid = this.edgeAt(wx, wy);
      if (eid) {
        this.host.onEditEdge(eid);
        return;
      }
    }
    const id = this.nodeAt(e);
    if (id) {
      // 双击 goal / action → 进入详情画布；其它类型静默 no-op（避免与双击空白创建冲突）
      const n = this.host.lib.nodes.find((x) => x.id === id);
      if (n && (n.type === 'goal' || n.type === 'action')) {
        this.host.onEnterDetail?.(id);
      }
      return;
    }
    // 双击空白 = 新建节点
    const [wx, wy] = this.toWorld(e.clientX, e.clientY);
    this.host.onCreate(Math.round(wx), Math.round(wy));
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.cancelVpAnim();
    const r = this.cv.getBoundingClientRect();
    const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.vp = zoomAt(this.vp, e.clientX - r.left, e.clientY - r.top, f);
    this.dirty = true;
  }

  /* ---------- 画布浮层 ---------- */
  //
  // 画布只能画像素，操作（改类型 / 删）必须用 DOM。
  // 浮层挂在画布容器上（不是画布里）—— canvas 上没有子元素。

  /** 浮层容器：画布的父元素（#vCanvas），坐标用它做基准 */
  private layer(): HTMLElement {
    return this.cv.parentElement ?? document.body;
  }

  /** 选中一条边时浮在边上的小操作条 */
  private buildEdgeBar(): HTMLElement {
    const bar = el('div', { class: 'edge-bar' });
    const chip = el('button', { class: 'edge-bar-type', title: t('action.editThisRelationFull') }, '');
    chip.onclick = () => {
      const id = this.host.selectedEdgeId;
      if (id) this.host.onEditEdge(id);
    };
    const del = el('button', { class: 'edge-bar-del', title: t('action.deleteThisRelation') }, '×');
    del.onclick = () => {
      const id = this.host.selectedEdgeId;
      if (id) this.host.onRemoveEdge(id);
    };
    bar.append(chip, del);
    bar.hidden = true;
    this.layer().append(bar);
    return bar;
  }

  /** 把操作条挪到选中边的中点上；没有选中就藏起来 */
  private syncEdgeBar(): void {
    if (!this.edgeBar) return;
    const id = this.host.selectedEdgeId;
    const edge = id ? this.host.lib.edges.find((e) => e.id === id) : null;
    if (!edge) { this.edgeBar.hidden = true; return; }
    const c = this.curveOf(edge.id);
    if (!c) { this.edgeBar.hidden = true; return; }
    const chip = this.edgeBar.querySelector('.edge-bar-type') as HTMLElement | null;
    if (chip) {
      chip.textContent = edgeTypeLabel(edge.type);
      chip.style.setProperty('--c', EDGE_TYPE_COLOR[edge.type]);
    }
    const r = this.cv.getBoundingClientRect();
    const pr = this.layer().getBoundingClientRect();
    const sx = c.mid.x * this.vp.scale + this.vp.tx;
    const sy = c.mid.y * this.vp.scale + this.vp.ty;
    this.edgeBar.style.left = `${sx + (r.left - pr.left)}px`;
    this.edgeBar.style.top = `${sy + (r.top - pr.top)}px`;
    this.edgeBar.hidden = false;
  }

  /** 拖线时跟着光标的类型徽标 */
  private buildLinkBadge(): HTMLElement {
    const b = el('div', { class: 'link-badge', title: t('detail.clickToChangeType') }, '');
    b.hidden = true;
    // ⚠️ 必须挡住：否则这一下 mousedown 会穿透到画布，mouseup 时就把线连出去了
    b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); this.linkMenuOpen = true; };
    b.onclick = (e) => { e.stopPropagation(); this.toggleLinkMenu(); };
    this.layer().append(b);
    return b;
  }

  private syncLinkBadge(): void {
    if (!this.linkBadge) return;
    if (!this.link) { this.linkBadge.hidden = true; return; }
    const r = this.cv.getBoundingClientRect();
    const pr = this.layer().getBoundingClientRect();
    this.linkBadge.textContent = edgeTypeLabel(this.link.type);
    this.linkBadge.style.setProperty('--c', EDGE_TYPE_COLOR[this.link.type]);
    this.linkBadge.style.left = `${this.link.sx + (r.left - pr.left)}px`;
    this.linkBadge.style.top = `${this.link.sy + (r.top - pr.top)}px`;
    this.linkBadge.hidden = false;
  }

  /** 拖线时的类型选择面板（换个类型再连，不用去侧栏图例） */
  private toggleLinkMenu(): void {
    if (this.linkMenu) { this.closeLinkMenu(); return; }
    if (!this.link) return;
    const n = this.host.lib.nodes.find((x) => x.id === this.link!.fromId);
    const menu = el('div', { class: 'link-menu' });
    for (const et of EDGE_TYPES) {
      if (et === 'belong') continue;
      // 这个类型从当前起点连得出去吗？连不出去的直接标灰
      const usable = !!n && (
        canConnect(et, { kind: 'node', type: n.type }, 'node') ||
        canConnect(et, { kind: 'node', type: n.type }, 'theme') ||
        canConnect(et, { kind: 'node', type: n.type }, 'stage')
      );
      const b = el('button', {
        class: 'link-menu-i' + (et === this.link.type ? ' on' : '') + (usable ? '' : ' off'),
        title: usable ? edgeTypeLabel(et) : t('error.relationNotAllowedHere'),
      }, edgeTypeLabel(et));
      b.style.setProperty('--c', EDGE_TYPE_COLOR[et]);
      if (usable) {
        b.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); this.linkMenuOpen = true; };
        b.onclick = (e) => {
          e.stopPropagation();
          this.setLinkType(et);
          this.closeLinkMenu();
          // 菜单关掉了 —— 接下来的拖拽松手要能真的连出去
          this.linkMenuOpen = false;
        };
      } else {
        b.disabled = true;
      }
      menu.append(b);
    }
    this.layer().append(menu);
    this.linkMenu = menu;
    // 面板贴着徽标
    const mr = this.linkBadge.getBoundingClientRect();
    const pr = this.layer().getBoundingClientRect();
    menu.style.left = `${mr.left - pr.left}px`;
    menu.style.top = `${mr.bottom - pr.top + 6}px`;
    this.linkMenuOpen = true;
  }

  private closeLinkMenu(): void {
    this.linkMenu?.remove();
    this.linkMenu = null;
  }

  /** 换这次要连的线类型 —— 合法目标要跟着重算 */
  private setLinkType(et: EdgeType): void {
    if (!this.link) return;
    this.link.type = et;
    const n = this.host.lib.nodes.find((x) => x.id === this.link!.fromId);
    if (n) this.link.valid = this.validTargets(et, n);
    // 图例也跟着变 —— 别让"下次连线类型"和"这次实际连的类型"对不上
    this.host.setEdgeType(et);
    this.syncLinkBadge();
    this.dirty = true;
  }

  /* ---------- 渲染循环（§6.5）---------- */

  private loop = (now: number): void => {
    const dt = this.lastFrame ? now - this.lastFrame : 0;
    this.lastFrame = now;
    if (this.dirty) {
      this.dirty = false;
      const t0 = performance.now();
      this.render();
      const cost = performance.now() - t0;
      // fps 在"仅脏时重绘"模型下没有意义，只报帧耗时
      this.host.onPerf(cost, dt);
      // 迷你地图是静态总览，不需要 60fps。在 1 万节点下它占了一半的 JS 开销。
      if (now - this.lastMM > 260) { this.lastMM = now; this.renderMinimap(); }
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private input(): RenderInput {
    const { w, h } = this.size;
    return {
      lib: this.host.lib, vp: this.vp, width: w, height: h, dpr: this.dpr,
      areaId: this.host.areaId, focusThemeId: this.host.focusThemeId, focusStageId: this.host.focusStageId,
      hideAreas: this.host.hideAreas,
      nodeTypes: this.host.nodeTypes,
      selected: this.host.selected, hovered: this.hover,
      searchActive: this.host.searchActive, contrast: this.host.contrast, theme: this.host.theme,
      lens: new Set(this.host.lens.map((n) => n.id)),
      hits: this.host.hits, ctxSet: this.host.ctxSet,
      hoverEdgeId: this.hoverEdge,
      selectedEdgeId: this.host.selectedEdgeId,
      linking: this.link
        ? { fromId: this.link.fromId, sx: this.link.sx, sy: this.link.sy, valid: this.link.valid, type: this.link.type }
        : null,
      marquee: this.marquee, index: this.index,
    };
  }

  private render(): void {
    this.renderer.draw(this.ctx, this.input());
    // 浮层跟着视口走（缩放 / 平移后要重新定位）
    this.syncEdgeBar();
    this.syncLinkBadge();
    // 缩放读数**跟着画布一起更新**。
    // ⚠️ 以前它在渲染循环里更新，于是任何**绕过循环的重绘**都会留下一块过期的读数：
    //    画布已经是 100%，读数还写着 25% —— 用户会以为缩放没生效。
    //    （自测 / 截图里的 renderNow 就是这种绕过循环的重绘。）
    const zv = document.getElementById('zv');
    if (zv) zv.textContent = Math.round(this.vp.scale * 100) + '%';
  }

  private renderMinimap(): void {
    const mm = this.mm;
    // 一个点都没有时，小地图画出来就是一块空板。
    // 留着它 = 右下角挂一个空方框，看着像坏了 —— 直接藏起来。
    if (!this.host.lib.nodes.length) { mm.hidden = true; return; }
    mm.hidden = false;
    const r = mm.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (mm.width !== Math.round(r.width * dpr)) { mm.width = Math.round(r.width * dpr); mm.height = Math.round(r.height * dpr); }
    this.mmCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.mmCtx.clearRect(0, 0, r.width, r.height);
    this.renderer.drawMinimap(this.mmCtx, r.width, r.height, this.input());
  }

  dispose(): void { cancelAnimationFrame(this.raf); this.ro?.disconnect(); this.ro = null; }
}
