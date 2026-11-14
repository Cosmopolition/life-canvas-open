/**
 * 原生自测钩子 —— 给 macOS 自测用的调试入口，从 App 里搬出来。
 *
 * 为什么单独拎出来：
 *   这些 `window.__lcXxx` 是**原生自测**的入口（macos/LifeCanvas/SelfTest.swift
 *   通过 evaluateJavaScript 按名字调它们），不是产品逻辑。
 *   它们原本埋在 App.bootCore() 开头，混在真正的启动代码中间 ——
 *   读启动流程的人得先跳过五百行调试钩子才知道程序启动干了什么；
 *   想改产品逻辑的人又怕碰坏了自测。两头都不友好。
 *
 * ⚠️ 名字是**契约**：原生那边按字符串取钩子，改名 = 原生自测全挂。
 *   钩子的行为（返回值形状、副作用、抛错的时机）也一个字都不能变。
 *
 * ⚠️ 为什么不把 App 整个交出去：
 *   钩子真正用到的读写入口只有下面 SelfTestContext 列的那些。
 *   把整个 App 递进去等于把它的私有面变成公共 API ——
 *   后面谁都能从外面改内部状态，"能跑但迟早出事"。
 *   所以这里只给钩子用得到的那几条，其余一律不给。
 */
import { Renderer } from '../canvas/renderer';
import type { Viewport } from '../canvas/viewport';
import { renderReviewCard, type CardTheme } from '../export/review-card';
import { getLocale, loadLocalePref, t } from '../i18n';
import { filterCount, isFilterActive, type FilterState } from '../model/filters';
import {
  MAIN_SPACE, buildWeekImports, parseWeekSpace, weekSourceCandidates, weekStart, weekSpaceId,
} from '../model/space';
import { visibleNodesByFocus } from '../model/selectors';
import { store } from '../model/store';
import type { Library, NodeType } from '../model/types';
import { toBundle, type ExportBundle } from '../persist/export';
import { $ } from '../ui/dom';
import { appBuild, appVersion, versionLabel } from '../version';
import type { CanvasView } from '../views/canvas-view';

/**
 * 钩子真正需要的读写入口 —— 一条一条列清楚。
 *
 * 约定：**getter 返回当下的值，action 干一件事**。
 * 不暴露 App 本体，也不暴露任何"拿到整个内部对象再自己改"的入口 ——
 * 要改什么就让 action 去改，改成什么样由 App 自己说了算。
 */
export interface SelfTestContext {
  /* ---------------- 画布 / 视口 ---------------- */
  /** 画布视图。没建好时是 undefined。 */
  canvas(): CanvasView | undefined;
  /** 画布当前的视口（缩放 + 平移）。画布还没建好时是 undefined。 */
  viewport(): Viewport | undefined;

  /* ---------------- 焦点 / 视图状态 ---------------- */
  /** 当前视图名（'canvas' / 'today' / …）。 */
  view(): string;
  /** 当前是不是停在详情画布里。 */
  isDetailView(): boolean;
  /** 主题焦点（null = 全部）。 */
  themeId(): string | null;
  /** 阶段焦点（null = 全部）。 */
  stageId(): string | null;
  /** 画布是不是已经定位过一次。 */
  canvasPositioned(): boolean;
  /** 设双焦点（主题 + 阶段）。 */
  setFocus(themeId: string | null, stageId: string | null): void;

  /* ---------------- 筛选 / 搜索 / 选中 ---------------- */
  /** 当前筛选状态。 */
  filter(): FilterState;
  /** 当前搜索词。 */
  query(): string;
  /** 搜索命中数。 */
  hitsCount(): number;
  /** 关系上下文集大小。 */
  ctxSetCount(): number;
  /** 选中的点数。 */
  selectedCount(): number;
  /** 当前选中的关系 id。 */
  selectedEdgeId(): string | null;
  /** 点亮的点类型筛选。 */
  nodeTypes(): NodeType[];
  /** 筛选透镜里的点数。 */
  lensCount(): number;

  /* ---------------- 动作 ---------------- */
  /** 只选中这一个点（别的选中全丢）。 */
  selectOnly(id: string): void;
  /** 选中一条关系（画布上高亮 + 边上浮出操作条）。返回是否选中成功。 */
  selectEdge(id: string): boolean;
  /** 丢掉不属于给定 id 集合的选中项。 */
  pruneSelected(validIds: Set<string>): void;
  /** 重画（视图、检视面板、空间索引…）。 */
  render(): void;
  /** 重置画布：把"看东西的状态"一次性清回原样，数据一个字节不动。 */
  resetCanvasView(): void;
  /** 重建搜索索引。 */
  resetSearchIndex(): void;
  /** 打开某个点的详情画布。 */
  pushDetail(nodeId: string): void;
  /** 载入示例库。 */
  loadSample(): Promise<void>;
  /** 复盘卡片的配色。 */
  cardTheme(): CardTheme;

  /* ---------------- 空间 ---------------- */
  /** 当前空间的库。 */
  spaceLib(): Library;

  /* ---------------- 自测备份 ---------------- */
  /** 自测期间备份下来的用户原库（换成示例数据之前存的）。 */
  selftestBackup(): ExportBundle | null;
  /** 记下 / 清掉自测备份。 */
  setSelftestBackup(backup: ExportBundle | null): void;
  /** 用给定库覆盖持久层（走仓储，走加密路径）。 */
  replaceAllLibrary(lib: Library): Promise<void>;

  /* ---------------- 侧栏 ---------------- */
  /** 侧栏宽度：当前生效值 + 断点默认值。 */
  panelWidths(): { cur: { left: number; right: number }; def: { left: number; right: number } };
  /** 直接把两侧栏宽度摆成给定的样子（自测前把布局摆成确定状态用）。 */
  setPanelWidths(l: number, r: number, persist: boolean): void;
}

/**
 * 装上全部自测钩子。
 *
 * 每个钩子都直接读 ctx 拿当下的状态 —— 不在这里缓存快照，
 * 否则自测跑到一半状态变了、钩子还报旧值，断言就成了假红。
 */
export function installSelfTestHooks(ctx: SelfTestContext): void {
  // 真实视口缩放（#zv 上显示的是取整百分比，看不出 44.9% 和 45.1% 的区别，
  // 而 LOD 阈值正好卡在 0.45 —— 差一丁点就换一套渲染路径）。
  // 原生自测和现场排查都靠它确认「到底进的是哪条渲染路径」。
  (window as unknown as Record<string, unknown>).__lcVp = () => ctx.canvas()?.viewport.scale ?? -1;
  // 完整视口（缩放 + 平移）。排查「画布是空的」时要知道的不只是缩放 ——
  // 视口平移出内容范围，画面上同样是什么都没有，而缩放读数完全正常。
  (window as unknown as Record<string, unknown>).__lcVpFull = () => {
    const v = ctx.viewport();
    return v ? { scale: v.scale, tx: v.tx, ty: v.ty } : null;
  };
  // 焦点 / 视图 / 定位状态。排查「画布上只有一部分数据」时要知道：
  // fit 装下的是**焦点过滤之后**的点 —— 焦点选错，缩放就跟着错。
  (window as unknown as Record<string, unknown>).__lcState = () => ({
    view: ctx.view(),
    themeId: ctx.themeId(),
    stageId: ctx.stageId(),
    positioned: ctx.canvasPositioned(),
    hasCanvas: !!ctx.canvas(),
    nodes: ctx.spaceLib().nodes.length,
    stages: store.lib.stages.length,
    themes: store.lib.themes.length,
    focusNodes: visibleNodesByFocus(ctx.spaceLib(), ctx.themeId(), ctx.stageId()).length,
  });
  /**
   * "看东西"的完整状态：焦点 / 筛选 / 搜索 / 选中 / 点类型。
   *
   * ⚠️ 为什么单独暴露：重置这个动作的价值全在"该清的清了、没有的多余的还在"。
   *    只看界面（角标 / 高亮 / 输入框）会漏掉一半 —— 比如筛选已经清了但
   *    lens 还指着旧集合，界面上看不出来，渲染结果却是错的。
   *    所以断言要读**实际生效的状态**，不是读界面元素。
   */
  (window as unknown as Record<string, unknown>).__lcView = () => ({
    themeId: ctx.themeId(),
    stageId: ctx.stageId(),
    filterActive: isFilterActive(ctx.filter()),
    filterCount: filterCount(ctx.filter()),
    query: ctx.query(),
    hits: ctx.hitsCount(),
    ctxSet: ctx.ctxSetCount(),
    selected: ctx.selectedCount(),
    selectedEdgeId: ctx.selectedEdgeId(),
    nodeTypes: [...ctx.nodeTypes()],
    lens: ctx.lensCount(),
    positioned: ctx.canvasPositioned(),
  });
  /**
   * 自测用：把库换成一份示例数据。
   *
   * ⚠️ 为什么要这个：自测跑在**用户真实数据**上，库可能是空的。
   *    空库时"焦点有没有被清掉""选中的点有没有被清掉"这两条断言
   *    恒真（本来就没东西可清），等于没测。
   *    所以自测要先有一份数据，才有东西可弄脏、也才有东西可验。
   *
   * ⚠️ ⚠️ 用完**必须**调 __lcRestoreData 把用户原库还回去 ——
   *    自测绝不能把用户的数据换成示例数据（那是不可逆的破坏）。
   *    这两个钩子是成对的：换之前自动备份，还的时候原样恢复。
   */
  (window as unknown as Record<string, unknown>).__lcLoadSample = async () => {
    // 备份用户原库（只在第一次换之前备份，反复调用不覆盖备份）
    if (!ctx.selftestBackup()) {
      ctx.setSelftestBackup(toBundle(store.lib));
    }
    await ctx.loadSample();
    return store.lib.nodes.length;
  };
  /** 把库恢复成自测之前的样子（把用户的数据还回去）。 */
  (window as unknown as Record<string, unknown>).__lcRestoreData = async () => {
    const backup = ctx.selftestBackup();
    if (!backup) return store.lib.nodes.length;
    await ctx.replaceAllLibrary(backup.library);
    store.replaceLibrary(backup.library);
    ctx.resetSearchIndex();
    ctx.setSelftestBackup(null);
    ctx.render();
    return store.lib.nodes.length;
  };
  // 选中一个点（原生自测用：检视面板里的「贴图」按钮在右栏，得先有选中）。
  (window as unknown as Record<string, unknown>).__lcSelect = (id: string) => {
    ctx.selectOnly(id);
  };
  // 库里的图片现状（原生自测用：证明图真的入库了、而且是缩过的 JPEG）
  (window as unknown as Record<string, unknown>).__lcImages = () => {
    const ns = ctx.spaceLib().nodes.filter((n) => n.imageData);
    const first = ns[0];
    return {
      count: ns.length,
      id: first?.id ?? null,
      prefix: first ? first.imageData!.slice(0, 24) : null,
      len: first ? first.imageData!.length : 0,
      w: first?.imageW ?? 0,
      h: first?.imageH ?? 0,
    };
  };
  // 挑一个**当前没有图**的点（原生自测用）。
  //
  // ⚠️ 为什么不能随便挑一个点：检视面板的按钮文案是按状态变的 ——
  //    已经有图的点显示「换图（上传）」，没图的才显示「贴图（…）」。
  //    自测按「贴图」两个字找按钮，选中一个带图的点就会**永远找不到**，
  //    看起来像功能坏了，其实只是找错了按钮。
  (window as unknown as Record<string, unknown>).__lcPlainNodeId = () => {
    const n = ctx.spaceLib().nodes.find((x) => !x.imageData && !x.imageUrl);
    return n?.id ?? null;
  };
  // 某个点上的图（原生自测用）。
  // ⚠️ 必须按 id 精确查 —— 用「第一个有图的点」会把用户自己的图也删掉。
  (window as unknown as Record<string, unknown>).__lcNodeImage = (id: string) => {
    const n = store.lib.nodes.find((x) => x.id === id);
    return n?.imageData
      ? {
          has: true,
          prefix: n.imageData.slice(0, 24),
          len: n.imageData.length,
          w: n.imageW ?? 0,
          h: n.imageH ?? 0,
        }
      : { has: false, prefix: null, len: 0, w: 0, h: 0 };
  };
  // 把某个点摆到视口中央（原生自测用）。
  // ⚠️ 必须摆过去再断言「画布上画出了这张图」——
  //    点在视口外时画布上本来就没有它，断言会恒假，
  //    看起来像"贴图没画出来"，其实是没看对地方。
  // 顺便报一下它落在哪儿：自测要能区分「图没画出来」和「压根没看对地方」。
  (window as unknown as Record<string, unknown>).__lcCenterOn = (id: string, scale = 1) => {
    const canvas = ctx.canvas();
    if (!canvas) return null;
    canvas.centerOn(id, scale);
    canvas.renderNow();
    const cv = $('#cv') as HTMLCanvasElement | null;
    const n = store.lib.nodes.find((x) => x.id === id);
    if (!cv || !n) return null;
    const vp = canvas.viewport;
    const r = cv.getBoundingClientRect();
    // 画布的变换是 translate(tx,ty) → scale(scale)，所以屏幕坐标 = 世界坐标 * scale + t
    const cx = (n.x + n.w / 2) * vp.scale + vp.tx;
    const cy = (n.y + n.h / 2) * vp.scale + vp.ty;
    return {
      scale: vp.scale,
      cx, cy,
      inView: cx >= 0 && cy >= 0 && cx <= r.width && cy <= r.height,
      cw: Math.round(r.width), ch: Math.round(r.height),
    };
  };
  // 当前画布焦点（主题 / 阶段）。
  //
  // ⚠️ 自测跑在**用户真实数据**上，焦点是用户自己设的 ——
  //    焦点外的点**根本不画**（renderer 里 lens / focus 过滤会 continue），
  //    于是"图明明贴上了，画布上却数不到像素"。
  //    自测必须先把焦点摆成确定状态（都空 = 全显），测完再还回去。
  (window as unknown as Record<string, unknown>).__lcFocus = () => ({
    themeId: ctx.themeId(), stageId: ctx.stageId(),
  });
  (window as unknown as Record<string, unknown>).__lcSetFocus = (
    themeId: string | null, stageId: string | null,
  ) => {
    ctx.setFocus(themeId, stageId);
    return { themeId: ctx.themeId(), stageId: ctx.stageId() };
  };
  // 某个点上的图**解开了吗**（原生自测用）。
  // 贴图入库 ≠ 画布上画出来了：图片要 decode 完才画得出来。
  // 等这个信号（而不是等 0.8 秒）才能断言"画布上真的有这张图"。
  (window as unknown as Record<string, unknown>).__lcImageReady = (id: string) => {
    const n = store.lib.nodes.find((x) => x.id === id);
    if (!n?.imageData) return false;
    return !!ctx.canvas()?.imageReady(n.imageData);
  };
  // 打开某个点的详情画布（原生自测 / 截图用）。
  (window as unknown as Record<string, unknown>).__lcOpenDetail = (id: string) => {
    ctx.pushDetail(id);
    return ctx.isDetailView();
  };
  // 画布上的**洋红像素数**（原生自测用）。
  //
  // ⚠️ 判据是**色相**不是精确 RGB：显示器色彩空间 + JPEG 有损压缩
  //    都会让洋红偏移几个值，写精确匹配必然假红。
  //    色相判据（R、B 都远高于 G）稳得多。
  //    画布配色里没有洋红（节点色最接近的 #d47f9a 差得远），
  //    所以「画布上出现了洋红」= 「这张图真的画上去了」。
  (window as unknown as Record<string, unknown>).__lcCanvasMagenta = () => {
    const c = $('#cv') as HTMLCanvasElement | null;
    if (!c) return -1;
    try {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] ?? 0, g = d[i + 1] ?? 0, b = d[i + 2] ?? 0;
        if (r > 180 && b > 180 && g < 100 && r - g > 100 && b - g > 100) n++;
      }
      return n;
    } catch { return -1; }
  };
  // 画布上出现的**不同颜色数**（调试用）。
  // ⚠️ 别拿它当「图画出来了」的证据 —— 不同颜色数只增不减，
  //    而且贴的那张图很可能全是画布上已有的颜色（断言恒假）。
  //    要证明"图画出来了"，用 __lcCanvasMagenta 数这张图的特征色像素。
  (window as unknown as Record<string, unknown>).__lcCanvasColors = () => {
    const c = $('#cv') as HTMLCanvasElement | null;
    if (!c) return -1;
    try {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set<string>();
      const step = 4 * 37;
      for (let i = 0; i < d.length; i += step) seen.add(`${d[i]},${d[i+1]},${d[i+2]}`);
      return seen.size;
    } catch { return -1; }
  };
  // 所有点的 id（调试用）
  (window as unknown as Record<string, unknown>).__lcNodeIds = () =>
    ctx.spaceLib().nodes.map((n) => n.id);
  /**
   * 数某个点的**那块区域**里有多少接近某色的像素（自测用）。
   *
   * 为什么限定在节点自己的范围里：全画布数颜色的话，
   * 用户自己别的图（同色）会让断言恒真 —— 看着像"功能正常"，
   * 其实根本没验到那个节点。
   *
   * @param tol 允许的色差（JPEG 有损 + 色彩空间偏移，实测要放宽一点）
   */
  (window as unknown as Record<string, unknown>).__lcNodeColorCount = (
    id: string, r: number, g: number, b: number, tol = 60,
  ) => {
    const c = $('#cv') as HTMLCanvasElement | null;
    const n = store.lib.nodes.find((x) => x.id === id);
    const canvas = ctx.canvas();
    if (!c || !n || !canvas) return -1;
    const vp = canvas.viewport;
    const rect = c.getBoundingClientRect();
    // 画布变换是 translate(tx,ty) → scale(scale)
    const sx = n.x * vp.scale + vp.tx;
    const sy = n.y * vp.scale + vp.ty;
    const sw = n.w * vp.scale;
    const sh = n.h * vp.scale;
    // 后备存储与 CSS 尺寸的比例
    const k = c.width / Math.max(1, rect.width);
    const x0 = Math.max(0, Math.floor(sx * k));
    const y0 = Math.max(0, Math.floor(sy * k));
    const x1 = Math.min(c.width, Math.ceil((sx + sw) * k));
    const y1 = Math.min(c.height, Math.ceil((sy + sh) * k));
    if (x1 <= x0 || y1 <= y0) return -1;
    try {
      const d = c.getContext('2d')!.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let cnt = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i]! - r) <= tol && Math.abs(d[i+1]! - g) <= tol && Math.abs(d[i+2]! - b) <= tol) cnt++;
      }
      return cnt;
    } catch { return -1; }
  };
  /**
   * 缩放手柄命中判定（自测用）：给屏幕坐标，返回命中的节点 id（没命中 = 空串）。
   */
  (window as unknown as Record<string, unknown>).__lcResizeHandleAt = (x: number, y: number) =>
    ctx.canvas()?.resizeHandleAtPoint(x, y) ?? '';
  /** 这个点在画布的空间索引里吗（自测用） */
  (window as unknown as Record<string, unknown>).__lcIndexHas = (id: string) =>
    ctx.canvas()?.indexHas(id) ?? false;
  /**
   * 把"看东西的状态"全清（焦点 / 筛选 / 搜索 / 选中 / 点类型）—— 数据一个字节不动。
   *
   * 自测用：画布只画"**看得见**的点"（焦点外的、筛选外的、没命中的都不画），
   * 测渲染之前必须先让它什么都能看见 ——
   * 否则"图画出来了"这条恒假，看着像功能坏了，其实是根本没画。
   */
  (window as unknown as Record<string, unknown>).__lcResetView = () => {
    ctx.resetCanvasView();
    return { view: ctx.view(), query: ctx.query(), selected: ctx.selectedCount() };
  };
  /**
   * 某个点的屏幕框 + 缩放手柄的屏幕坐标（自测用）。
   *
   * 自测要模拟"抓住右下角往右下拖"——
   * 得知道手柄在屏幕上的**确切**位置，不然按下去的是节点本体（变成拖动节点）。
   */
  (window as unknown as Record<string, unknown>).__lcNodeBox = (id: string) => {
    const n = store.lib.nodes.find((x) => x.id === id);
    const cv = $('#cv') as HTMLCanvasElement | null;
    const canvas = ctx.canvas();
    if (!n || !cv || !canvas) return null;
    const vp = canvas.viewport;
    const r = cv.getBoundingClientRect();
    const s = Renderer.nodeSize(n);
    const left = r.left + n.x * vp.scale + vp.tx;
    const top = r.top + n.y * vp.scale + vp.ty;
    return {
      x: n.x, y: n.y, w: n.w, h: n.h,
      sw: s.w, sh: s.h,
      left, top,
      right: left + s.w * vp.scale,
      bottom: top + s.h * vp.scale,
      // 手柄画在 (x+w, y+h) 那个角上
      handleX: left + s.w * vp.scale,
      handleY: top + s.h * vp.scale,
      scale: vp.scale,
      // 节点那块区域的**后备存储**像素数（数颜色时用来算占比）
      area: Math.max(1, Math.round(s.w * vp.scale * (cv.width / Math.max(1, r.width)) *
        s.h * vp.scale * (cv.width / Math.max(1, r.width)))),
    };
  };
  /**
   * 渲一张复盘卡片（自测用）—— 只渲不导。
   *
   * 返回尺寸、截断标记、**卡片上会出现的每一行字**，以及 PNG 的头几个字符。
   * ★ toDataURL 会抛 SecurityError（canvas 被跨域图污染）——
   *   所以这一条同时验了「外链图先转 dataURL」那个坑没踩。
   */
  (window as unknown as Record<string, unknown>).__lcReviewCard = async () => {
    const nodes = ctx.spaceLib().nodes;
    const w = parseWeekSpace(store.currentSpaceId);
    const res = await renderReviewCard({
      nodes,
      weekLabel: w ? w.label : t('week.thisWeek'),
      rangeText: w ? w.range : '',
      theme: ctx.cardTheme(),
      showFooter: true,
    });
    let png = '';
    try {
      const url = res.canvas.toDataURL('image/png');
      png = url.slice(0, 22) + '|' + url.length;
    } catch (e) {
      png = 'THREW:' + (e as Error).message;
    }
    return {
      w: res.canvas.width,
      h: res.canvas.height,
      clipped: res.clipped,
      skipped: res.skippedImages,
      lines: res.lines,
      metaLines: res.metaLines,
      png,
      titles: nodes.map((n) => n.title),
      contents: nodes.map((n) => n.content),
    };
  };
  /* ---------- 空间（自测用） ---------- */
  // 切到某个空间。阶段一还没有 UI 入口切空间，这里是唯一的途径 ——
  // 等阶段三有了「空间切换器」，这个接口就只留给自测用了。
  (window as unknown as Record<string, unknown>).__lcSetSpace = (spaceId: string) => {
    store.currentSpaceId = spaceId;
    // 选中集合里不属于新空间的点要丢掉（跟 gotoSpace 一样）——
    // 不丢的话检视面板会显示"该点已被删除"，看着像数据被删了。
    const ids = new Set(ctx.spaceLib().nodes.map((n) => n.id));
    ctx.pruneSelected(ids);
    ctx.render();
    return store.currentSpaceId;
  };
  (window as unknown as Record<string, unknown>).__lcSpace = () => store.currentSpaceId;
  /** 某个空间的节点数（全库口径） */
  (window as unknown as Record<string, unknown>).__lcSpaceNodeCount = (spaceId: string) =>
    store.lib.nodes.filter((n) => n.spaceId === spaceId).length;
  /** 当前空间在画布上拿到的节点 id —— 用来验「没有别的空间漏进来」 */
  (window as unknown as Record<string, unknown>).__lcSpaceNodeIds = () =>
    ctx.spaceLib().nodes.map((n) => n.id);
  /** 当前空间节点的坐标快照 —— 用来验「切空间没有破坏布局」 */
  (window as unknown as Record<string, unknown>).__lcNodePositions = () => {
    const o: Record<string, string> = {};
    for (const n of ctx.spaceLib().nodes) o[n.id] = `${n.x},${n.y}`;
    return o;
  };
  /**
   * 界面语言 + 图例 chip 上的文字（自测用）。
   *
   * ★ 为什么图例要单独读：
   *   图例是"**只建一次**"的 DOM（建完只换文字），而页面其它文案是每次重绘。
   *   所以"切语言后标题变了、chip 没变"这种分裂，
   *   读整页文字是发现不了的 —— 必须**单独读 chip 的文字**。
   */
  (window as unknown as Record<string, unknown>).__lcLocale = () => ({
    locale: getLocale(),
    pref: loadLocalePref(),
    legend: Array.from(document.querySelectorAll('#lgType .lg')).map((x) => x.textContent ?? ''),
    edgeLegend: Array.from(document.querySelectorAll('#lgEdge .lg')).map((x) => x.textContent ?? ''),
  });
  /**
   * 当前显示的版本号（自测用）。
   *
   * 原生自测拿它跟 Bundle 里的版本比 —— 两者必须一致，
   * 不一致就说明「设置里显示的版本」跟「正在跑的包」脱节了。
   */
  (window as unknown as Record<string, unknown>).__lcVersion = () => ({
    version: appVersion(),
    build: appBuild(),
    label: versionLabel(),
  });
  /** 在某个空间造一个点（自测/截图用来铺场景） */
  (window as unknown as Record<string, unknown>).__lcMakeNode = (
    title: string, spaceId?: string, time?: string, type?: NodeType, tags?: string[],
  ) => {
    const n = store.addNode({
      type: type ?? 'idea', title,
      spaceId: spaceId ?? store.currentSpaceId,
      time, tags,
    });
    ctx.render();
    return n.id;
  };
  /**
   * 造一个「作品」图卡（带图的点）—— 阶段四的截图/自测用。
   *
   * 图卡 = type='work' + 有图 ⇒ 图片铺满整块、标题压下缘。
   * 尺寸默认给得比较大（图卡的意义是"以图为主"，小了就看不出形态）。
   */
  (window as unknown as Record<string, unknown>).__lcMakeImageCard = (
    title: string, imageData: string,
    opts?: { x?: number; y?: number; w?: number; h?: number; spaceId?: string; imageW?: number; imageH?: number },
  ) => {
    const n = store.addNode({
      type: 'work', title, imageData,
      imageW: opts?.imageW ?? 800, imageH: opts?.imageH ?? 600,
      x: opts?.x ?? 0, y: opts?.y ?? 0,
      w: opts?.w ?? 320, h: opts?.h ?? 220,
      spaceId: opts?.spaceId ?? store.currentSpaceId,
    });
    ctx.render();
    return n.id;
  };
  /**
   * 删一个点（自测清理用）。
   * ⚠️ 按 id 精确删 —— 绝不能删"第一个点"，那可能是用户自己的东西。
   *    自测跑在用户真实数据上，临时点删不干净就是往用户库里留垃圾。
   */
  (window as unknown as Record<string, unknown>).__lcDeleteNode = (id: string) => {
    store.removeNode(id);
    ctx.render();
    return store.lib.nodes.some((n) => n.id === id);
  };
  /* ---------- 周画布：引入原数据（自测用） ---------- */
  /**
   * 把主空间里的这些点复制进那一周的周画布。返回副本 id 数组。
   *
   * 走的是**和 UI 同一套**逻辑（buildWeekImports）—— 自测验的是真路径，
   * 不是一条"只为测试存在的"平行实现。
   */
  (window as unknown as Record<string, unknown>).__lcImportWeek = (
    monday: string, ids: string[],
  ) => {
    const mon = weekStart(monday);
    const spaceId = weekSpaceId(mon);
    const srcs = store.lib.nodes.filter((n) => ids.includes(n.id) && n.spaceId === MAIN_SPACE);
    const payloads = buildWeekImports(srcs, mon, spaceId);
    const made = payloads.map((p) => store.addNode({ ...p, spaceId }).id);
    ctx.render();
    return made;
  };
  /** 某个点的来源 id（副本 → 原件）。没有来源就是空串。 */
  (window as unknown as Record<string, unknown>).__lcNodeSource = (id: string) =>
    store.lib.nodes.find((n) => n.id === id)?.sourceId ?? '';
  /** 某个点落在哪个空间（验"副本真的落在周空间、原件还在主空间"） */
  (window as unknown as Record<string, unknown>).__lcNodeSpace = (id: string) =>
    store.lib.nodes.find((n) => n.id === id)?.spaceId ?? '';
  /** 主空间里"这一周"的候选 id（引入面板会列出来的那些） */
  (window as unknown as Record<string, unknown>).__lcWeekCandidates = (monday: string) =>
    weekSourceCandidates(store.lib, weekStart(monday)).map((n) => n.id);
  /** 当前空间里的点：id / 标题 / 来源 id（截图与自测要挑出"哪些是副本"） */
  (window as unknown as Record<string, unknown>).__lcSpaceNodes = () =>
    ctx.spaceLib().nodes.map((n) => ({ id: n.id, title: n.title, sourceId: n.sourceId ?? '' }));
  /* ---------- 连线（关系）---------- */
  // 所有关系（自测 / 排查用）
  (window as unknown as Record<string, unknown>).__lcEdges = () =>
    ctx.spaceLib().edges.map((e) => ({
      id: e.id, fromId: e.fromId, toId: e.toId, type: e.type, note: e.note ?? '',
    }));
  // 选中一条关系（画布上会高亮 + 边上浮出操作条）
  (window as unknown as Record<string, unknown>).__lcSelectEdge = (id: string) =>
    ctx.selectEdge(id);
  // 某条关系中点的屏幕坐标（自测要能"点到那条线"）
  (window as unknown as Record<string, unknown>).__lcEdgePoint = (id: string) =>
    ctx.canvas()!.edgeScreenPoint(id);
  // 某个点的屏幕坐标：'handle' = 右侧的连线手柄，'center' = 点中心
  // （自测要能"从手柄拖一条线出来"）
  (window as unknown as Record<string, unknown>).__lcNodePoint = (id: string, which: string) => {
    const n = store.lib.nodes.find((x) => x.id === id);
    if (!n) return null;
    const v = ctx.canvas()!.viewport;
    const r = ($('#cv') as HTMLCanvasElement).getBoundingClientRect();
    const s = Renderer.nodeSize(n);
    const wx = which === 'handle' ? n.x + s.w + 1 : n.x + s.w / 2;
    const wy = n.y + s.h / 2;
    return { x: r.left + wx * v.scale + v.tx, y: r.top + wy * v.scale + v.ty };
  };
  // 把某个点的图拿掉（自测跑在用户真实容器上，贴完必须还回去）。
  // ⚠️ 按 id 精确删 —— 绝不能删"第一个有图的点"，
  //    那可能是用户自己存的照片。
  (window as unknown as Record<string, unknown>).__lcRemoveImage = (id: string) => {
    store.updateNode(id, { imageData: undefined, imageW: undefined, imageH: undefined, imageUrl: undefined });
    ctx.render();
  };
  // 侧栏宽度的读 / 写。
  // 原生自测要一个**确定的**布局：用户要是把侧栏收起过，
  // 「拖左栏 → 画布变宽」这类断言就无从谈起（画布本来就已经是满宽了）。
  // 所以自测前把布局摆成「两栏都展开」，自测结束再原样还给用户。
  (window as unknown as Record<string, unknown>).__lcPanels = () => ctx.panelWidths();
  (window as unknown as Record<string, unknown>).__lcSetPanels = (
    l: number, r: number, persist = false,
  ) => {
    ctx.setPanelWidths(l, r, persist);
  };
}
