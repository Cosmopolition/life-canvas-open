/**
 * 左右侧栏分隔条（画布全屏）—— 从 App 里搬出来的内聚一块。
 *
 * 为什么单独拎出来：
 *   「侧栏多宽」这件事的状态（默认值 / 当前生效值 / 用户意图值）、
 *   几何换算、DOM 定位、落盘规则，**全都只服务于这一个功能**。
 *   它们原先散在 App 的七个方法里，中间还夹着视图、搜索、加密等不相干的逻辑 ——
 *   改侧栏宽度要跨着半个 App 找线索。现在这块自己成篇。
 *
 * ⚠️ 三份宽度不是冗余，各有各的用处：
 *   panelDefault   —— 断点给的默认值（收起后再展开回到这个宽度）
 *   panelWidth     —— 当前**生效**的宽度（会被窗口宽度夹小）
 *   panelUserWidth —— 用户**意图**的宽度（不会被夹，落盘只认它）
 *   为什么要分开，见各字段的注释。
 *
 * 几何换算（panelMax / widthFromPointer / clampPair）在 ui/splitter.ts 里，
 * 那边是纯函数、可以单测；这里只管 DOM 和状态。
 */
import { $ } from '../ui/dom';
import { PANEL_STEP, clampPair, panelMax, toggleWidth, widthFromPointer } from '../ui/splitter';

/** 两侧栏的宽度（px）。0 = 收起。 */
export interface PanelWidths { left: number; right: number }

/**
 * App 交给分隔条的两条读写入口。
 *
 * ⚠️ 只有落盘这一件事需要 App 参与（宽度要写进 settings），
 *    所以这里只给两条 —— 剩下的状态和几何全在模块内部，不外泄。
 */
export interface SplitterHost {
  /**
   * 上次存下来的宽度。
   * undefined = 没存过 → 用断点默认值。
   */
  savedWidths(): { left?: number; right?: number };
  /**
   * 落盘。left / right 传 undefined 表示「等于默认值，不记」。
   */
  saveWidths(left: number | undefined, right: number | undefined): void;
}

export class Splitters {
  /** 分隔条的默认宽度（断点给的）。收起后再展开回到这个宽度。 */
  private panelDefault: PanelWidths = { left: 252, right: 344 };
  /** 当前生效的侧栏宽度（0 = 收起）。窗口变窄时会被夹小。 */
  private panelWidth: PanelWidths = { left: 252, right: 344 };
  /**
   * 用户**意图**的宽度 —— 只被拖动 / 双击 / 键盘改，不会被窗口宽度夹。
   *
   * ⚠️ 为什么和 panelWidth 分开：
   *    窗口变窄时侧栏会被 clamp 砍小（比如 216 → 164），那是**为了当下窗口**
   *    做的临时调整，不是用户的选择。可要是拿被砍过的值去落盘，
   *    用户下次在宽窗口启动就会发现侧栏莫名变窄了 —— 宽度"自己变了"。
   *    所以落盘只认这里。
   */
  private panelUserWidth: PanelWidths = { left: 252, right: 344 };

  private readonly host: SplitterHost;

  constructor(host: SplitterHost) {
    this.host = host;
  }

  /**
   * 装上左右分隔条：拖着调侧栏宽度，拖到屏幕边上侧栏收起、画布占满整宽。
   *
   * 宽度写在 `#app` 的行内样式（--lw/--rw）上 —— 行内样式压得住媒体查询，
   * 所以用户拖出来的宽度不会在窗口缩放时被断点默认值冲掉。
   */
  init(): void {
    const app = $('#app')!;
    const sl = $('#splitL') as HTMLElement | null;
    const sr = $('#splitR') as HTMLElement | null;
    if (!sl || !sr) return;

    // 断点默认值：读 --lw-def/--rw-def，**不读** --lw/--rw。
    // 行内样式优先级最高，读 --lw 读到的是「当前生效值」
    // （可能是用户拖的，也可能已经被窗口宽度夹过）——
    // 分不清"用户没动过"和"被夹小了"，落盘就会出错。
    const cs = getComputedStyle(app);
    const defL = parseFloat(cs.getPropertyValue('--lw-def')) || 252;
    const defR = parseFloat(cs.getPropertyValue('--rw-def')) || 344;
    this.panelDefault = { left: defL, right: defR };

    // 恢复上次的宽度/收起状态
    const saved = this.host.savedWidths();
    const savedL = saved.left;
    const savedR = saved.right;
    this.panelUserWidth = {
      left: savedL === undefined ? defL : savedL,
      right: savedR === undefined ? defR : savedR,
    };
    this.panelWidth = { ...this.panelUserWidth };
    this.applyPanelWidths(true);

    const bind = (el: HTMLElement, side: 'left' | 'right') => {
      const dir: 1 | -1 = side === 'left' ? 1 : -1;
      let startX = 0, startW = 0;

      el.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        // 合成事件没有"活动指针"，setPointerCapture 会抛 NotFoundError。
        // 捕获只是锦上添花（拖出分隔条也要跟手），抛了就当没有。
        try { el.setPointerCapture(ev.pointerId); } catch { /* 忽略 */ }
        el.classList.add('dragging');
        document.body.classList.add('splitting');
        startX = ev.clientX;
        startW = this.panelWidth[side];
        const move = (e: PointerEvent) => {
          const max = panelMax(window.innerWidth);
          const w = widthFromPointer(startX, startW, e.clientX, dir, max);
          this.setPanelWidth(side, w);
        };
        const up = () => {
          el.classList.remove('dragging');
          document.body.classList.remove('splitting');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          this.savePanelWidths();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });

      // 双击：收起 ↔ 展开
      el.addEventListener('dblclick', () => {
        const w = toggleWidth(this.panelWidth[side], this.panelDefault[side]);
        this.setPanelWidth(side, w);
        this.savePanelWidths();
      });

      // 键盘：方向键微调，Home 收起，Enter 切换
      el.addEventListener('keydown', (e) => {
        const k = e.key;
        let w = this.panelWidth[side];
        if (k === 'ArrowLeft' || k === 'ArrowRight') {
          const step = (k === 'ArrowLeft' ? -1 : 1) * PANEL_STEP * (side === 'left' ? 1 : -1);
          w = Math.max(0, Math.min(panelMax(window.innerWidth), w + step));
        } else if (k === 'Home') {
          w = 0;
        } else if (k === 'Enter' || k === ' ') {
          w = toggleWidth(this.panelWidth[side], this.panelDefault[side]);
        } else {
          return;
        }
        e.preventDefault();
        this.setPanelWidth(side, w);
        this.savePanelWidths();
      });
    };
    bind(sl, 'left');
    bind(sr, 'right');

    // 窗口尺寸变了，分隔条要重新贴边；宽度也要按新窗口重新夹一次。
    // 顺带重读断点默认值 —— 窗口跨过断点时，"默认宽度"本身也变了。
    window.addEventListener('resize', () => {
      this.refreshPanelDefaults();
      this.clampPanelsToWindow();
      this.positionSplitters();
    });
    this.positionSplitters();
  }

  /** 当前侧栏宽度：生效值 + 断点默认值。 */
  widths(): { cur: PanelWidths; def: PanelWidths } {
    return { cur: { ...this.panelWidth }, def: { ...this.panelDefault } };
  }

  /**
   * 直接把两侧栏宽度摆成给定的样子。
   *
   * 自测前要把布局摆成确定状态（用户要是把侧栏收起过，
   * 「拖左栏 → 画布变宽」这类断言就无从谈起），测完再原样还给用户。
   */
  setWidths(l: number, r: number, persist = false): void {
    this.panelUserWidth.left = l;
    this.panelUserWidth.right = r;
    this.panelWidth.left = l;
    this.panelWidth.right = r;
    this.applyPanelWidths();
    this.positionSplitters();
    if (persist) this.savePanelWidths();
  }

  /**
   * 重读断点给的默认宽度。
   *
   * 断点变了，默认档位就变了（≤1280 是 216/320，≥1281 是 264/360）。
   * 不跟着更新的话，"用户没动过"这个判断会拿旧档位比 ——
   * 用户在宽窗口拖到 264（正好是窄档的默认）会被当成"自定义值"存下去。
   */
  private refreshPanelDefaults(): void {
    const app = $('#app');
    if (!app) return;
    const cs = getComputedStyle(app);
    const defL = parseFloat(cs.getPropertyValue('--lw-def'));
    const defR = parseFloat(cs.getPropertyValue('--rw-def'));
    if (defL > 0) this.panelDefault.left = defL;
    if (defR > 0) this.panelDefault.right = defR;
  }

  /**
   * 写侧栏宽度到 CSS 变量 + 记到内存状态。
   *
   * 这是"用户改宽度"的唯一入口（拖动 / 键盘 / 调试钩子都走它），
   * 所以**同时**更新生效值和用户意图值。
   */
  private setPanelWidth(side: 'left' | 'right', w: number): void {
    this.panelUserWidth[side] = w;
    this.panelWidth[side] = w;
    this.applyPanelWidths();
    this.positionSplitters();
  }

  /** 两侧宽度一起套用到 DOM（并按窗口宽度夹一次，防止把画布挤没）。 */
  private applyPanelWidths(clamp = false): void {
    if (clamp) this.clampPanelsToWindow();
    const app = $('#app')!;
    app.style.setProperty('--lw', `${this.panelWidth.left}px`);
    app.style.setProperty('--rw', `${this.panelWidth.right}px`);
  }

  /**
   * 窗口变了，宽度重新按新窗口夹一次。
   * 只夹"太大"的，不动用户特意调小的那边（0 = 收起，要保住）。
   *
   * ⚠️ 只改**生效值**，不改用户意图值（panelUserWidth）。
   *    夹出来的小值是为了当下窗口做的临时调整 —— 拿它去落盘的话，
   *    用户下次在宽窗口启动会发现侧栏莫名变窄。
   */
  private clampPanelsToWindow(): void {
    const avail = window.innerWidth;
    const c = clampPair(this.panelWidth.left, this.panelWidth.right, avail);
    this.panelWidth = c;
    this.applyPanelWidths();
  }

  /**
   * 分隔条贴到面板的实际边缘。
   *
   * 不用 CSS 变量算位置 —— 断点下侧栏会变成抽屉（绝对定位、屏幕外）
   * 或固定宽度，变量和实际边缘对不上，分隔条就会飘。
   *
   * 侧栏收起时另算：这时面板只剩 1px 边框，照着它摆的话分隔条有一半
   * 在屏幕外 —— 屏幕上什么抓手都没有，用户找不到"这里还能拖回去"。
   * 所以收起时把它**整个收进屏幕内**、靠边贴住，把手正好落在边上。
   */
  private positionSplitters(): void {
    const app = $('#app');
    const sl = $('#splitL') as HTMLElement | null;
    const sr = $('#splitR') as HTMLElement | null;
    if (!app || !sl || !sr) return;
    const appRect = app.getBoundingClientRect();
    const l = ($('#left') as HTMLElement | null)?.getBoundingClientRect();
    const r = ($('#right') as HTMLElement | null)?.getBoundingClientRect();
    // 命中区 12px，中心压在边缘上
    const lCollapsed = this.panelWidth.left <= 0;
    const rCollapsed = this.panelWidth.right <= 0;
    if (l) {
      sl.style.left = lCollapsed
        ? '0px'
        : `${Math.round(l.right - appRect.left - 6)}px`;
      sl.classList.toggle('collapsed', lCollapsed);
    }
    if (r) {
      sr.style.left = rCollapsed
        ? `${Math.round(appRect.width - 12)}px`
        : `${Math.round(r.left - appRect.left - 6)}px`;
      sr.classList.toggle('collapsed', rCollapsed);
    }
    sl.setAttribute('aria-valuenow', String(this.panelWidth.left));
    sr.setAttribute('aria-valuenow', String(this.panelWidth.right));
  }

  /**
   * 宽度和收起状态记进设置（下次启动还是这个布局）。
   *
   * ⚠️ 宽度等于断点默认值时**不记**（存 undefined）：
   * 记下来的话，"默认宽度"就变成了某个具体数字 —— 换个窗口宽度它也不再跟着变，
   * 而且自测（在 1280 宽的窗口里跑）会把用户 1920 宽窗口的默认值改掉。
   * 只记真正的自定义值和**收起**状态（0 ≠ 默认，值得记）。
   *
   * ⚠️ 落盘用**用户意图值**（panelUserWidth），不是当前生效值：
   *    生效值可能已经被窗口宽度夹小了（216 → 164）。
   *    拿被夹过的值落盘，用户下次在宽窗口启动会发现侧栏莫名变窄。
   */
  private savePanelWidths(): void {
    this.host.saveWidths(
      this.panelUserWidth.left === this.panelDefault.left ? undefined : this.panelUserWidth.left,
      this.panelUserWidth.right === this.panelDefault.right ? undefined : this.panelUserWidth.right,
    );
  }
}
