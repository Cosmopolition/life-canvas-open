/**
 * 应用装配层：把 store / 持久化 / 搜索 / 三个视图接到一起。
 * 所有用户交互最终都走 store，视图不直接改数据（AD-09）。
 */
import {
  EDGE_TYPE_COLOR, edgeTypeLabel, EDGE_TYPES, NODE_TYPES,
  NODE_TYPE_COLOR, nodeTypeLabel, statusLabel, type EdgeType, type Library, type LifeTheme, type NodeType,
} from './model/types';
import { store } from './model/store';
import {
  MAIN_SPACE, WEEK_REVIEW_TAG, buildWeekImports, currentMonth, dayLabel, isWeekSpace,
  nodeDay, parseWeekSpace, shiftMonth, spaceTitle, spaceView, weekDays, weekSpaceId,
  weekSourceCandidates, weekSpaceStats, weekSpaces,
} from './model/space';
import {
  expandOneHop, focusPath, inStage, themeChain, visibleNodesByFocus,
} from './model/selectors';
import {
  allStatuses, allTags, applyFilter, describe as describeFilter, emptyFilter,
  filterCount, isFilterActive, monthRange, passes as passesFilter,
  type FilterState,
} from './model/filters';
import { applyA11y, applyTheme, db, defaultSettings, effectiveTheme, loadSettings, saveSettings, saveCryptoConfig, systemTheme, type Settings } from './persist/db';
import { Repository } from './persist/repository';
import type { CryptoConfig } from './persist/crypto';
import { setupPassword, verifyPassword } from './persist/crypto';
import { download, fromBundle, toBundle, toJsonCanvas, toMarkdown } from './persist/export';
import { buildAreaTemplate, buildSampleLibrary, buildStressLibrary } from './data/seed';
import { buildAreaTemplateEn, buildSampleLibraryEn } from './data/seed-en';
import { SearchIndex } from './search/query';
import { CanvasView } from './views/canvas-view';
import { renderTimeline } from './views/timeline-view';
import { renderInspector, renderList, askReason } from './views/list-view';
import { openReviewCard as openReviewCardPanel } from './views/review-card-view';
import { type CardTheme } from './export/review-card';
import { openEdgeEditor } from './views/edge-editor';
import { dayShift, renderToday, todayKey } from './views/today-view';
import { todayNodes } from './model/selectors';
import { renderDetail, type DetailHost } from './views/detail-view';
import { renderWeekCalendar } from './views/week-calendar-view';
import { $, confirmBox, el, escapeHtml, modal, toast } from './ui/dom';
import { loadImageFile } from './canvas/image-input';
import { emit, enable as enableShell, isNative, type ShellCommand } from './platform/shell';
import { fmtMonthDay, getLocale, onLocaleChange, t } from './i18n';
import { applyNativeLocale, bootLocale, reportLocaleToNative } from './i18n/runtime';
import { setNativeVersion } from './version';
import { installSelfTestHooks, type SelfTestContext } from './app/selftest-hooks';
import { openSettingsMenu, type SettingsMenuHost } from './app/settings-menu';
import { Splitters } from './app/splitters';

type View = 'canvas' | 'tl' | 'lv' | 'wk' | 'today' | 'detail';

export class App {
  private repo = new Repository(store);
  private search = new SearchIndex();
  private canvas!: CanvasView;
  /** 原生模式：等原生把选好的文件内容送回来。null = 没在等。 */
  private importResolver: ((f: { name: string; text: string; error?: string; cancelled?: boolean }) => void) | null = null;
  /**
   * 原生模式：等原生把选好的**图片**送回来。null = 没在等。
   *
   * 闭包里带着节点 id —— 原生那边不知道用户是在给哪个点贴图，
   * 是 web 这边记着的（跟导入同一个模式）。
   */
  private imageResolver: ((f: { name: string; dataUrl: string; w: number; h: number; error?: string; cancelled?: boolean }) => void) | null = null;
  /** 画布是否已经定位过一次（第一次进画布视图时定位，之后不打扰用户） */
  private canvasPositioned = false;
  /**
   * 自测期间的用户原库备份（自测换成示例数据之前存下，测完原样还回去）。
   *
   * ⚠️ 为什么必须有：自测跑在**用户真实数据**上。为了让断言有东西可验，
   *    自测会临时换成示例空间 —— 要是忘了还回去，
   *    用户的数据就被示例数据覆盖了（不可逆的破坏）。
   */
  private selftestBackup: ReturnType<typeof toBundle> | null = null;
  private settings: Settings = defaultSettings();

  private view: View = 'today';
  /** 主题焦点：双焦点之一（节点需满足 inTheme） */
  private themeId: string | null = null;
  /** 阶段焦点：双焦点之一（节点需满足 inStage） */
  private stageId: string | null = null;
  /**
   * 当前空间在 `store.currentSpaceId` 上 —— store 是唯一事实源，
   * app 层只读它，不另存一份（两处各存一份必然不同步）。
   *
   * 'default' = 主画布；'week:2026-11-02' = 那一周的复盘画布。
   * 空间的标题、起止、周次全部从 id 本身解析（见 model/space.ts）。
   */
  /** @deprecated 旧单焦点；保留为 `themeId` 兼容 shim 直至 Phase 9 清理 */
  get areaId(): string | null { return this.themeId; }
  /** 今日视图当前浏览的日期，YYYY-MM-DD。开屏/点"回到今日"重置为今天 */
  private todayDate: string = todayKey();
  /** 周历当前显示的月份，YYYY-MM。默认当月（不记忆上次打开的月） */
  private calendarMonth: string = currentMonth();
  /** 今日视图软安排行：当前正在编辑的那一条 id，null = 没有编辑态 */
  private editingSoftId: string | null = null;
  private nodeTypes = new Set<NodeType>();
  private selected = new Set<string>();
  private hits = new Set<string>();
  private ctxSet = new Set<string>();
  private edgeType: EdgeType = 'support';
  /** 当前选中的关系（画布上高亮 + 边上浮出操作条） */
  private selectedEdgeId: string | null = null;
  /** 状态 / 标签 / 时间筛选（需求文档 8.5） */
  private filter: FilterState = emptyFilter();
  /** 详情画布的栈：栈顶 = 当前展示节点。重启清空（MVP-1 不持久化） */
  private detailStack: Array<{ nodeId: string }> = [];
  /** 进入详情前所在的视图：栈 pop 到空时回到这里 */
  private preDetailView: View = 'canvas';
  private sessionKey: CryptoKey | null = null;
  private idleTimer = 0;
  private lastActivity = Date.now();
  /** 系统当前外观。原生外壳推过来的值优先；纯浏览器里读 prefers-color-scheme。 */
  private systemTheme: 'dark' | 'light' = 'dark';

  async boot(): Promise<void> {
    // ★ 先定语言。后面的文案全走 t() —— 语言定晚了，
    //   首屏会先闪一下旧语言（中文）再跳成英文。
    bootLocale();
    // 切语言 → 整体重绘一次（视图、检视面板、空状态里的文案都是 t() 出来的）。
    // 门禁期间不重绘 —— 那时屏幕上只有门禁卡片，它的文案由 i18n 层单独刷。
    onLocaleChange(() => {
      if (document.getElementById('app')?.hidden) return;
      this.render();
    });

    this.settings = await loadSettings();
    applyA11y(this.settings);
    this.systemTheme = systemTheme();
    applyTheme(this.settings, this.systemTheme);
    await db.open();
    this.bindHeader();
    this.bindShortcuts();
    this.watchSystemTheme();

    // 原生外壳接管顶栏。必须在 showGate 之前 —— 门禁卡片期间顶栏就该让位，
    // 否则会出现"web 顶栏闪一下再消失"。桥的存在性与解锁状态无关。
    if (enableShell((c) => this.onShellCommand(c))) {
      emit('ready', { view: this.view });
      // ★ 把 web 定好的语言报给原生。
      //   原生启动时按**系统语言**摆好界面（中文系统 → 中文顶栏），
      //   而 web 这边可能定成另一种（用户锁过 / 浏览器是英文）。
      //   不报的话两边永远对不上：顶栏中文、界面英文。
      //   必须在 enableShell 之后 —— 原生通道没建好之前发出去会静默丢掉。
      reportLocaleToNative();
      // 用户上次把主题锁成了暗色/亮色：把原生窗口的外观也钉过去。
      // 不然窗口是系统外观（浅色）、内容是暗色，两边对不上。
      if (this.settings.theme !== 'auto') {
        emit('themeChanged', { theme: this.settings.theme });
      }
    }

    const raw = await db.meta.get('cryptoEnabled');
    if (raw === undefined) {
      // 首次运行 —— AD-06：加密默认开，先让用户设主密码
      this.showGate('setup');
    } else if (raw.value === true) {
      this.showGate('unlock');
    } else {
      this.repo.setKey(null);
      await this.enterApp();
    }
  }

  /* ---------------- 原生外壳桥接 ---------------- */

  /** 原生 → web 的分发。菜单项、工具栏、快捷键最终都落到这里。 */
  private onShellCommand(c: ShellCommand): void {
    switch (c.type) {
      case 'view':
        if (c.view === 'canvas' || c.view === 'tl' || c.view === 'lv' || c.view === 'wk' || c.view === 'today') {
          this.switchView(c.view);
        }
        return;
      case 'search':
        this.setQuery(c.q);
        return;
      case 'action':
        this.runAction(c.action);
        return;
      case 'theme':
        this.setTheme(c.theme);
        return;
      case 'locale':
        // 原生报来的系统语言。只有"用户没显式选过语言"（跟随系统）时才采纳 ——
        // macOS 的「每个 App 单独设语言」只有原生进程看得见，
        // 浏览器那份 navigator.language 看不到它。
        applyNativeLocale(c.locale);
        return;
      case 'appInfo':
        // 原生报来的版本号（正在跑的这个包的）。收到就盖掉构建期的值 ——
        // 开发期跑裸二进制、发布版跑 bundle，版本可能不一样。
        setNativeVersion(c.version, c.build);
        return;
      case 'focusCanvas':
        // 原生工具栏的点击不会触发 app.ts 里那个把焦点还给 #cv 的 mousedown，
        // 而画布快捷键有 activeElement === #cv 的守卫。不显式还回去，
        // 方向键 / n / f / +- 会静默失效。
        ($('#cv') as HTMLElement | null)?.focus();
        return;
      case 'importFile': {
        // 原生读好了文件，把内容送过来
        const r = this.importResolver;
        this.importResolver = null;
        r?.({ name: c.name, text: c.text, error: c.error, cancelled: c.cancelled });
        return;
      }
      case 'imageFile': {
        // 原生选好并缩放好了图片，把 dataURL 送过来
        const r = this.imageResolver;
        this.imageResolver = null;
        r?.({
          name: c.name, dataUrl: c.dataUrl, w: c.w, h: c.h,
          error: c.error, cancelled: c.cancelled,
        });
        return;
      }
    }
  }

  /** 动作名 → 对应 web 顶栏按钮。原生侧不重复实现业务，只认这几个名字。 */
  private runAction(action: string): void {
    const sel: Record<string, string> = {
      filter: '#btnFilter', focus: '#btnFocus', export: '#btnExport',
      keys: '#btnKeys', settings: '#btnSettings', new: '#btnNew',
      import: '#btnImport',
      // 重置画布的按钮在画布浮层里（不在顶栏）：原生模式顶栏整个被隐藏，
      // 放顶栏的话桌面端就找不到入口了。
      reset: '#zReset',
    };
    const s = sel[action];
    // $ 的类型标成非空但实为 querySelector，未知 action 会走到空选择器抛异常，
    // 所以先挡掉，别把原生传错的 action 变成一次崩溃。
    if (!s) return;
    document.querySelector<HTMLElement>(s)?.click();
  }

  /** 搜索的唯一入口：web 输入框和原生搜索框都走这里，状态不会分叉。 */
  private setQuery(q: string): void {
    const box = $('#q') as HTMLInputElement | null;
    if (box && box.value !== q) box.value = q;
    void this.runSearch(q);
  }

  /**
   * 原生推来的系统外观。
   *
   * 只有「跟随系统」才采纳 —— 用户在设置里显式选了暗色/亮色时，
   * 系统变浅变深都不该把他选的主题改回去。
   */
  private setTheme(theme: 'dark' | 'light'): void {
    const before = effectiveTheme();
    this.systemTheme = theme;
    const after = applyTheme(this.settings, theme);
    if (after === before) return;
    this.canvas?.invalidate();
    this.render();
  }

  /**
   * 纯浏览器环境下盯着系统的深浅色变化。
   * 原生外壳里由原生推（原生推的是窗口的 effectiveAppearance，更准）。
   */
  private watchSystemTheme(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      if (this.settings.theme !== 'auto') return;
      this.setTheme(mq.matches ? 'light' : 'dark');
    };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
  }

  /* ---------------- 解锁流程（AD-06 / §7.1）---------------- */

  private showGate(mode: 'setup' | 'unlock'): void {
    const gate = $('#gate')!;
    const pw = $('#gatePw') as HTMLInputElement;
    const pw2 = $('#gatePw2') as HTMLInputElement;
    const err = $('#gateErr')!;
    const ok = $('#gateOk') as HTMLButtonElement;
    const noCrypto = $('#gateNoCrypto') as HTMLButtonElement;

    gate.hidden = false;
    $('#app').hidden = true;
    pw2.style.display = mode === 'setup' ? '' : 'none';
    ok.textContent = mode === 'setup' ? t('action.createAndEnter') : t('crypto.unlock');
    $('#gateTitle').textContent = mode === 'setup' ? t('crypto.setMasterPassword') : t('crypto.unlock');
    $('#gateSub').textContent = mode === 'setup'
      ? t('crypto.localOnlyNotice')
      : t('crypto.lockedExplain');
    pw.value = ''; pw2.value = ''; err.textContent = '';
    setTimeout(() => pw.focus(), 40);

    ok.onclick = async () => {
      ok.disabled = true;
      err.textContent = '';
      try {
        if (mode === 'setup') {
          if (pw.value.length < 6) { err.textContent = t('crypto.minLength'); return; }
          if (pw.value !== pw2.value) { err.textContent = t('error.passwordMismatch'); return; }
          const { config, key } = await setupPassword(pw.value);
          await saveCryptoConfig(config);
          await db.meta.put({ key: 'cryptoEnabled', value: true });
          this.sessionKey = key;
          this.repo.setKey(key);
          await this.enterApp();
        } else {
          const cfg = await db.meta.get('cryptoConfig');
          const conf = cfg?.value as CryptoConfig;
          if (!conf?.salt || !conf?.verifier) { err.textContent = t('error.cryptoConfigMissing'); return; }
          const key = await verifyPassword(pw.value, conf);
          if (!key) { err.textContent = t('error.wrongPassword'); return; }
          this.sessionKey = key;
          this.repo.setKey(key);
          await this.enterApp();
        }
      } catch (e) {
        err.textContent = t('error.generic', { msg: (e as Error).message });
      } finally {
        ok.disabled = false;
      }
    };

    noCrypto.hidden = mode !== 'setup';
    noCrypto.onclick = async () => {
      await db.meta.put({ key: 'cryptoEnabled', value: false });
      this.repo.setKey(null);
      await this.enterApp();
    };

    pw.onkeydown = pw2.onkeydown = (e) => { if (e.key === 'Enter') ok.click(); };
  }

  private async enterApp(): Promise<void> {
    $('#gate').hidden = true;
    $('#app').hidden = false;
    emit('lockChanged', { locked: false });

    // v2→v3 迁移：旧 LifeArea 拆到 themes / stages。
    // 必须在 load() 之前跑，否则 store 会按旧形状读进来、UI 走错字段。
    // 没启用加密的库：areas 表是空 / 不存在，runSchemaMigration 内部会早退。
    try {
      await this.repo.runSchemaMigration();
    } catch (e) {
      console.error('[schema migration] 失败，下次启动重试', e);
      // 不阻断进入：脏数据保留，刷新页面再试一次
    }

    // 性能压测入口：?stress=N 直接灌合成库（§6.6 的 1 万节点指标用）。
    // 必须在读库之前分流，否则会白读一遍又整库重写。
    const stressN = Number(new URLSearchParams(location.search).get('stress') ?? 0);
    // 压测库只灌一次；之后每次都走真实读库路径，冷启动数据才有意义
    const existing = await this.repo.load();
    if (stressN > existing.nodes.length) {
      const stress = buildStressLibrary(stressN);
      await this.repo.replaceAll(stress);
      store.replaceLibrary(stress);
      existing.nodes = stress.nodes; existing.edges = stress.edges;
    }

    let lib$ = existing;
    store.replaceLibrary(lib$);

    this.canvas = new CanvasView($('#cv') as HTMLCanvasElement, ($('#mm') as HTMLCanvasElement), {
      // ★ 画布的唯一数据入口。是 getter 不是快照 ⇒ 切空间后画布自动跟着变，
      //   不需要重建画布实例，也不需要重新 fit。
      get lib() { return app.spaceLib(); },
      get areaId() { return app.canvasFocusTheme(); },
      get focusThemeId() { return app.canvasFocusTheme(); },
      get focusStageId() { return app.canvasFocusStage(); },
      // 周画布里不画主题 / 阶段框 —— 它是"这一周的复盘"，不是主画布那张主题地图
      get hideAreas() { return app.inWeekSpace(); },
      get nodeTypes() { return app.nodeTypes.size ? app.nodeTypes : null; },
      get selected() { return app.selected; },
      get hits() { return app.hits; },
      get ctxSet() { return app.ctxSet; },
      get searchActive() { return !!app.query; },
      get contrast() { return app.settings.contrast === 'high'; },
      get theme() { return effectiveTheme(); },
      get lens() { return app.lens(); },
      onSelect: (ids) => { this.selected = new Set(ids); this.render(); },
      onMove: (id, x, y, done, resize) => {
        const n = store.lib.nodes.find((v) => v.id === id);
        if (!n) return;
        // 拖动中实时更新；done=true 时只触发一次 invalidate，避免 mouseup
        // 把位置归零（canvas-view 用 0,0 当哨兵值通知完成）。
        if (!done) store.moveNode(id, x, y, resize);
        this.canvas.updateIndex(n);
        if (done) this.canvas.invalidate();
      },
      onCreate: (x, y) => void this.createNodeAt(x, y),
      onLink: (from, toId, type) => {
        // 目标 id 查三表 + 旧 area
        const to =
          store.lib.nodes.find((v) => v.id === toId) ??
          store.lib.themes.find((v) => v.id === toId) ??
          store.lib.stages.find((v) => v.id === toId);
        let toKind: 'node' | 'theme' | 'stage' | 'area' = 'node';
        if (to && 'title' in to && 'content' in to) toKind = 'node';
        else if (to && to.kind === 'theme') toKind = 'theme';
        else if (to && to.kind === 'stage') toKind = 'stage';
        else if (to) toKind = 'area';
        // 重复关系不新建：同方向 + 同类型 + 同备注 = 同一条线。
        // （以前可以无限拖出重复的线 —— 用户那边就出现了两条一模一样的「启发」。）
        const dup = store.lib.edges.find((e) =>
          e.fromId === from.id && e.toId === toId && e.type === type &&
          (e.note ?? '') === '');
        if (dup) {
          toast(t('error.relationExists'));
          // 直接把已有的那条选中：用户一眼就能看到"原来在这儿"
          this.selectedEdgeId = dup.id;
          this.canvas.invalidate();
          return;
        }
        // 兜底：store 会拒绝跨空间的连线（正常情况下 UI 选不到别的空间的点）
        try {
          store.addEdge({ fromId: from.id, fromKind: from.kind, toId, toKind, type });
          toast(t('toast.connected', { type: edgeTypeLabel(type) }));
        } catch (err) {
          toast(err instanceof Error ? err.message : t('error.lineCannotConnect'));
        }
      },
      onRemoveEdge: (eid) => void this.removeEdgeWithConfirm(eid),
      get selectedEdgeId() { return app.selectedEdgeId; },
      onSelectEdge: (id) => {
        this.selectedEdgeId = id;
        this.canvas.invalidate();
      },
      onEditEdge: (id) => void this.openEdgeEditor(id),
      setEdgeType: (et) => this.setEdgeType(et),
      onEnterDetail: (id) => this.pushDetail(id),
      onRequestReason: (rt, p) => askReason(rt, p),
      getEdgeType: () => this.edgeType,
      onPerf: (cost) => {
        const el = $('#perf');
        const lib = this.spaceLib();
        if (el) el.textContent = t('common.nodeEdgeCount', { n: lib.nodes.length, m: lib.edges.length })
          + '\n' + t('perf.msPerFrame', { c: cost.toFixed(1) });
      },
    });

    this.bootCore();
    if (stressN > 0) {
      this.themeId = null; this.stageId = null;
      this.canvas.fit(undefined, 0.3);   // 压测就是要看全局
      setTimeout(() => toast(t('stress.mode', { n: stressN })), 500);
      return;
    }
    // 开局落在最近阶段上（按 end 降序排，否则取无起止的），不要 1 万节点全览
    const initialLib = store.lib;
    const stages = [...initialLib.stages].sort((a, b) => (b.end ?? '').localeCompare(a.end ?? ''));
    const defaultStage = stages.find((s) => s.end) ?? stages.find((s) => !s.start && !s.end) ?? stages[0];
    if (defaultStage) {
      this.stageId = defaultStage.id;
      // ⚠️ 这里**只设焦点，不定位** —— 画布此刻还是隐藏的（默认停在今日视图），
      //    隐藏元素的尺寸是 0×0，此刻算 fit 只会得到 8% 和一个错位的视口。
      //    定位放在 switchView('canvas') 里：第一次进画布时做（见 switchView）。
    }
    this.resetIdle();
    void this.updateStates();
    void $('#q').focus();
    // 首次启动引导：与是否载入示例解耦，空库也要走一遍
    void this.maybeOnboard();
    // 画布是刚建好的 —— 如果此刻当前视图就是画布（原生分段控件抢先切过），
    // 补一次定位。switchView 那次调用时 CanvasView 还不存在，定位没跑成。
    this.positionCanvasOnce();
  }

  /* ---------------- M7：首次引导 ---------------- */

  private async maybeOnboard(): Promise<void> {
    const done = await db.meta.get('onboardDone');
    if (done?.value) return;
    this.onboard(0);
  }

  /**
   * 首次引导的三步文案。
   *
   * ⚠️ 做成 getter 而不是普通属性：属性在**实例构造时**求值，
   *    那时界面语言还没定下来 —— 切语言之后这里会留着旧语言的文案。
   *    getter 每次读都重新走 t()，语言变了自然跟着变。
   */
  private get STEPS(): Array<{ t: string; b: string; d: string }> {
    return [
      {
        t: t('onboard.canvasTagline'),
        b: t('onboard.hintNoGoal'),
        d: t('onboard.hintSample'),
      },
      {
        t: t('onboard.taglineWriteAndConnect'),
        b: t('onboard.hintCanvas'),
        d: t('help.actionNodeNoCheckbox'),
      },
      {
        t: t('onboard.hintSearchWeb'),
        b: t('onboard.hintSearch'),
        d: t('onboard.hintTimeline'),
      },
    ];
  }

  private onboard(i: number): void {
    const el = $('#onboard')!;
    const dots = $('#onboardDots')!;
    dots.innerHTML = this.STEPS.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('');
    const st = this.STEPS[i]!;
    ($('#onboardTitle') as HTMLElement).textContent = st.t;
    ($('#onboardBody') as HTMLElement).textContent = st.b;
    ($('#onboardDemo') as HTMLElement).innerHTML = st.d;
    const next = $('#onboardNext') as HTMLButtonElement;
    next.textContent = i === this.STEPS.length - 1 ? t('onboard.getStarted') : t('onboard.next');
    el.hidden = false;
    next.onclick = async () => {
      if (i === this.STEPS.length - 1) { el.hidden = true; await db.meta.put({ key: 'onboardDone', value: true }); }
      else this.onboard(i + 1);
    };
    ($('#onboardSkip') as HTMLButtonElement).onclick = async () => {
      el.hidden = true;
      await db.meta.put({ key: 'onboardDone', value: true });
    };
    next.focus();
  }

  /** 重新打开引导（设置里入口） */
  showOnboard(): void { this.onboard(0); }

  /* ---------------- M7：空状态与无结果 ---------------- */

  private updateStates(): void {
    const lib = this.spaceLib();
    // 空间条：常驻。当前在哪个空间、能不能切、周画布专属的两个动作。
    // （局部名不用 isWeekSpace —— 那名字被 space.ts 的函数占着。）
    const inWeek = store.currentSpaceId !== MAIN_SPACE;
    const sw = $('#spaceSwitch');
    if (sw) {
      const w = parseWeekSpace(store.currentSpaceId);
      sw.textContent = w ? `${w.label} · ${w.range} ▾` : t('app.name') + ' ▾';
    }
    const wkReviewBtn = $('#wkReview');
    const wkImportBtn = $('#wkImport');
    const wkCardBtn = $('#wkCard');
    const spaceBackBtn = $('#spaceBack');
    if (wkReviewBtn) wkReviewBtn.hidden = !inWeek;
    if (wkImportBtn) wkImportBtn.hidden = !inWeek;
    if (wkCardBtn) wkCardBtn.hidden = !inWeek;
    if (spaceBackBtn) spaceBackBtn.hidden = !inWeek;
    // 周画布里不能新建主题 / 阶段（主题与阶段是全局共用的）⇒ 侧栏入口藏掉。
    // 留着按钮只会让人点出"这个周画布里新建的主题算谁的"这种问题。
    const addThemeBtn = $('#btnAddTheme');
    const treeActs = addThemeBtn?.parentElement;
    if (treeActs) treeActs.hidden = inWeek;
    // 主题 / 阶段在周画布里**整块不参与**：
    // 不能新建、不能聚焦（聚焦是主画布的组织工具，带进来会把这一周的内容滤掉）、
    // 画布上也不画框 ⇒ 留着只会让人以为"这一周也有阶段面"。
    const secAreas = $('#secAreas');
    if (secAreas) secAreas.hidden = inWeek;
    // 空间菜单：开着的时候才重画（关着的时候没必要动 DOM）
    const spaceMenu = $('#spaceMenu');
    if (spaceMenu && !spaceMenu.hidden) this.renderSpaceMenu();
    // 空库：整张画布没有东西
    const empty = $('#canvasEmpty')!;
    if (this.view === 'canvas' && !lib.nodes.length) {
      empty.innerHTML =
        `<div class="es-card">
           <svg class="es-icon" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
             <circle cx="5" cy="7" r="2.2"/><circle cx="19" cy="6" r="2.2"/><circle cx="12" cy="17" r="2.2"/>
             <path d="M6.8 8.4 10.5 15M16.4 7.8 13.4 15.2"/>
           </svg>
           <h3>${t('empty.stillEmpty')}</h3>
           <p>${t('onboard.hintNoGoal2')}</p>
           <div class="es-acts">
             <button class="btn acc" id="esNew">${t('onboard.noteFirst')}</button>
             <button class="btn" id="esTemplate">${t('onboard.createPanelFromTemplate')}</button>
             <button class="btn" id="esLoad">${t('onboard.loadSampleSpaceToLook')}</button>
           </div>
         </div>`;
      empty.hidden = false;
      ($('#esNew') as HTMLButtonElement).onclick = () => {
        const r = ($('#cv') as HTMLCanvasElement).getBoundingClientRect();
        void this.createNodeAt(Math.round(r.width / 2), Math.round(r.height / 2));
      };
      ($('#esTemplate') as HTMLButtonElement).onclick = () => {
        // 兼容旧 buildAreaTemplate：按 type 拆到 themes / stages
        let themeCount = 0, stageCount = 0;
        // 模板名是**用户数据**（新建出来的主题叫什么），不走 t() ——
        // 所以英文界面要另取一份英文模板，不能翻译中文模板。
        const tpls = getLocale() === 'en-US' ? buildAreaTemplateEn() : buildAreaTemplate();
        for (const tpl of tpls) {
          if (tpl.type === 'root' || tpl.type === 'theme') {
            store.addTheme({ name: tpl.name, color: tpl.color });
            themeCount++;
          } else {
            store.addStage({ name: tpl.name, color: tpl.color });
            stageCount++;
          }
        }
        this.render();
        toast(t('toast.themesStagesCreated', { a: themeCount, b: stageCount }));
      };
      ($('#esLoad') as HTMLButtonElement).onclick = () => void this.loadSample();
    } else {
      empty.hidden = true;
    }

    // 搜索无结果：直接给一条"要不要现在记下来"的出路
    const noHit = $('#noHit')!;
    if (this.view === 'canvas' && this.query && !this.hits.size) {
      noHit.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <span>${t('search.noResultsFor', { q: escapeHtml(this.query) })}</span>
        <button id="nhCreate">${t('empty.noteNow')}</button>`;
      noHit.hidden = false;
      ($('#nhCreate') as HTMLButtonElement).onclick = () => {
        const r = ($('#cv') as HTMLCanvasElement).getBoundingClientRect();
        void this.createNodeAt(Math.round(r.width / 2), Math.round(r.height / 2), this.query);
      };
    } else {
      noHit.hidden = true;
    }
  }

  private async loadSample(): Promise<void> {
    // 示例空间里的标题、正文、关系备注全是**用户数据**，不走 t() ——
    // 英文界面要载入的是另一份平行写好的英文示例（src/data/seed-en.ts）。
    const sample = getLocale() === 'en-US' ? buildSampleLibraryEn() : buildSampleLibrary();
    const lib = {
      ...sample,
      nodes: sample.nodes.map((n) => ({ ...n, spaceId: 'default' })),
      edges: sample.edges.map((e) => ({ ...e, spaceId: 'default' })),
    };
    await this.repo.replaceAll(lib);
    store.replaceLibrary(lib);
    this.resetSearchIndex();
    // 默认焦点：取有 end 的第一个 stage，其次是 themes[0]
    const defaultStage = lib.stages.find((s) => s.end) ?? lib.stages[0];
    if (defaultStage) this.stageId = defaultStage.id;
    else if (lib.themes[0]) this.themeId = lib.themes[0].id;
    this.render();
    toast(t('toast.sampleLoaded'));
  }

  /* ---------------- M7：键盘 ---------------- */

  /** 方向键选择：在该方向上找最近的点 */
  private moveSelection(dir: 'up' | 'down' | 'left' | 'right'): void {
    const lib = this.spaceLib();
    const cur = this.selected.size === 1 ? lib.nodes.find((n) => n.id === [...this.selected][0]) : undefined;
    const vp = this.canvas?.viewport;
    if (!vp) return;
    const cx = cur ? cur.x + cur.w / 2 : -vp.tx / vp.scale + 100;
    const cy = cur ? cur.y + cur.h / 2 : -vp.ty / vp.scale + 100;
    const near = lib.nodes
      .filter((n) => (cur ? n.id !== cur.id : true))
      .map((n) => {
        const dx = n.x + n.w / 2 - cx, dy = n.y + n.h / 2 - cy;
        const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
        const off = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
        // 主要方向要对齐，横向偏移越小越好
        return { n, along, cost: along > 12 ? along + off * 2.2 : Infinity };
      })
      .filter((x) => x.cost < Infinity)
      .sort((a, b) => a.cost - b.cost)[0];
    if (!near) return;
    this.selected = new Set([near.n.id]);
    this.canvas.centerOn(near.n.id, Math.max(vp.scale, 0.7));
    if (this.sideTimer) { clearTimeout(this.sideTimer); this.sideTimer = null; }
    this.render();
  }

  private showKeys(): void {
    void modal({
      title: t('help.shortcuts'), okText: t('action.gotIt'), cancelText: t('action.close'),
      body: (card) => {
        const grid = el('div', { class: 'keys-grid' });
        grid.innerHTML = `<div class="keys-sec">${t('view.canvas')}</div>
           <div class="keys-row"><span>${t('help.arrowKeys')}</span><span><kbd>←</kbd> <kbd>↑</kbd> <kbd>↓</kbd> <kbd>→</kbd></span></div>
           <div class="keys-row"><span>${t('canvas.pan')}</span><kbd>${t('help.dragEmpty')}</kbd></div>
           <div class="keys-row"><span>${t('canvas.marqueeSelect')}</span><span><kbd>Shift</kbd> ${t('action.addDrag')}</span></div>
           <div class="keys-row"><span>${t('action.newNode')}</span><span><kbd>N</kbd> ${t('help.orDoubleClick')}</span></div>
           <div class="keys-row"><span>${t('action.fitAll')}</span><kbd>F</kbd></div>
           <div class="keys-row"><span>${t('action.resetCanvas')}</span><kbd>R</kbd></div>
           <div class="keys-row"><span>${t('canvas.zoomInOut')}</span><span><kbd>+</kbd> <kbd>−</kbd></span></div>
           <div class="keys-sec">${t('focus.global')}</div>
           <div class="keys-row"><span>${t('action.search')}</span><kbd>/</kbd></div>
           <div class="keys-row"><span>${t('action.switchView')}</span><span><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></span></div>
           <div class="keys-row"><span>${t('action.deleteSelection')}</span><kbd>Del</kbd></div>
           <div class="keys-row"><span>${t('action.cancelOrClose')}</span><kbd>Esc</kbd></div>
           <div class="keys-row"><span>${t('week.thisPanel')}</span><kbd>?</kbd></div>`;
        card.append(grid);
      },
    });
  }

  /** 视图、索引、仓储绑定 —— 示例库和压测库共用 */
  private bootCore(): void {
    // 自测钩子：原生自测（macos/LifeCanvas/SelfTest.swift）按名字取 window.__lcXxx。
    // ⚠️ 钩子的名字和行为是**契约** —— 搬模块时一个字都不能改，
    //    详见 app/selftest-hooks.ts 顶头的说明。
    installSelfTestHooks(this.selfTestContext());
    this.repo.bind();
    // 画布立刻重绘；侧栏/检视/空间索引是重活，延后再做。
    // 拖拽一个节点时 mousemove 会连续触发 emit，全量同步会让帧耗时翻十倍。
    store.subscribe(() => {
      this.refreshSearch();
      if (this.view === 'canvas') this.canvas.invalidate();
      this.scheduleSide();
    });
    this.canvas.rebuildIndex(this.spaceLib());
    this.resetSearchIndex();
    // 一次性整理：早期 bug 留下的"叠在 (0,0)"的今日节点
    this.spreadStuckToday(todayKey());
    this.splitters.init();
    this.render();
    this.resetIdle();
  }

  /**
   * 自测钩子要用的读写入口 —— 一条一条列清楚。
   *
   * ⚠️ 为什么不在钩子模块里直接拿 App：
   *    那样等于把 App 的私有面全变成公共 API。钩子真正用到的只有下面这些，
   *    多给一条都是把口子撕大。所以这里逐条列出来，钩子模块按名单取。
   *
   * 全是**闭包**：取值的那一刻才读 this 里的状态 —— 钩子是在自测期间
   * 随时被调的，缓存快照会让断言读到旧值。
   */
  private selfTestContext(): SelfTestContext {
    return {
      /* 画布 / 视口 */
      canvas: () => this.canvas,
      viewport: () => this.canvas?.viewport,
      /* 焦点 / 视图状态 */
      view: () => this.view,
      isDetailView: () => this.view === 'detail',
      themeId: () => this.themeId,
      stageId: () => this.stageId,
      canvasPositioned: () => this.canvasPositioned,
      setFocus: (themeId, stageId) => { this.setFocus(themeId, stageId); },
      /* 筛选 / 搜索 / 选中 */
      filter: () => this.filter,
      query: () => this.query,
      hitsCount: () => this.hits.size,
      ctxSetCount: () => this.ctxSet.size,
      selectedCount: () => this.selected.size,
      selectedEdgeId: () => this.selectedEdgeId,
      nodeTypes: () => [...this.nodeTypes],
      lensCount: () => this.lens().length,
      /* 动作 */
      selectOnly: (id) => { this.selected = new Set([id]); this.render(); },
      selectEdge: (id) => {
        this.selectedEdgeId = id;
        this.canvas.invalidate();
        return this.selectedEdgeId === id;
      },
      pruneSelected: (validIds) => {
        if (this.selected.size) this.selected = new Set([...this.selected].filter((id) => validIds.has(id)));
      },
      render: () => { this.render(); },
      resetCanvasView: () => { this.resetCanvasView(); },
      resetSearchIndex: () => { this.resetSearchIndex(); },
      pushDetail: (nodeId) => { this.pushDetail(nodeId); },
      loadSample: () => this.loadSample(),
      cardTheme: () => this.cardTheme(),
      /* 空间 */
      spaceLib: () => this.spaceLib(),
      /* 自测备份 */
      selftestBackup: () => this.selftestBackup,
      setSelftestBackup: (backup) => { this.selftestBackup = backup; },
      replaceAllLibrary: (lib) => this.repo.replaceAll(lib),
      /* 侧栏 */
      panelWidths: () => this.splitters.widths(),
      setPanelWidths: (l, r, persist) => { this.splitters.setWidths(l, r, persist); },
    };
  }

  /* ---------------- 左右侧栏分隔条 ---------------- */

  /**
   * 侧栏分隔条 —— 宽度状态、几何换算、DOM 定位全在 app/splitters.ts 里。
   *
   * 这边只留两件 App 才做得了的事：
   *   ① 宽度要**落盘**进设置（那边要加密、要存库）
   *   ② 初始化时把上次存的宽度**喂回去**（恢复用户上次的布局）
   * 其余一律不外泄 —— 分隔条自己管自己那三份宽度。
   */
  private splitters = new Splitters({
    savedWidths: () => ({ left: this.settings.leftW, right: this.settings.rightW }),
    saveWidths: (left, right) => {
      this.settings.leftW = left;
      this.settings.rightW = right;
      void saveSettings(this.settings);
    },
  });

  private async lock(): Promise<void> {
    this.search.dispose();
    this.sessionKey = null;
    store.replaceLibrary({ nodes: [], edges: [], themes: [], stages: [], milestones: [], versions: [], customStatuses: [] });
    this.selected.clear(); this.hits.clear(); this.ctxSet.clear();
    this.detailStack = [];
    this.showGate('unlock');
    // 原生据此收起工具栏：锁定期间只剩门禁卡片，
    // 留着一排点不动的按钮比没有更糟
    emit('lockChanged', { locked: true });
    toast(t('crypto.locked'));
  }

  private resetIdle(): void {
    clearTimeout(this.idleTimer);
    if (!this.sessionKey) return;
    this.lastActivity = Date.now();
    this.idleTimer = window.setTimeout(() => {
      if (Date.now() - this.lastActivity > this.settings.lockMinutes * 60_000) void this.lock();
    }, Math.max(10, this.settings.lockMinutes) * 60_000 / 4);
  }

  /* ---------------- 渲染 ---------------- */

  /**
   * 当前空间的库视图 —— 只有这个空间的节点和边。
   *
   * ★ 视图层、渲染层、选择器拿到的都是这个**已经过滤好**的 lib，
   *   所以它们不需要知道自己处理的是哪个空间。
   *
   * 按 id 查单个节点的地方仍然用全库 `store.lib` —— id 全局唯一，
   * 而且操作对象必然就在当前空间里。
   */
  private spaceLib(): Library {
    return spaceView(store.lib, store.currentSpaceId);
  }

  /** 现在在不在周画布里 */
  inWeekSpace(): boolean {
    return isWeekSpace(store.currentSpaceId);
  }

  /**
   * 画布用的主题焦点。
   *
   * ★ 周画布里恒为 null：焦点是主画布的组织工具（"我现在看事业这一面"）。
   *   带着它进周画布 ⇒ 那一周不属于这个阶段的点全被过滤掉，
   *   用户看到的是一张空画布，还以为"这周什么都没引入"。
   */
  canvasFocusTheme(): string | null {
    return this.inWeekSpace() ? null : this.themeId;
  }

  /** 画布用的阶段焦点（同 canvasFocusTheme：周画布里恒为 null） */
  canvasFocusStage(): string | null {
    return this.inWeekSpace() ? null : this.stageId;
  }

  private sideTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleSide(): void {
    if (this.sideTimer) clearTimeout(this.sideTimer);
    this.sideTimer = setTimeout(() => { this.sideTimer = null; this.render(); }, 150);
  }

  private render(): void {
    // 视图的显隐由 this.view 单点决定，收在这里。
    //
    // 以前这段只写在 switchView 里，而初始 DOM（index.html）把 vCanvas 留成可见、
    // vToday 留成 hidden —— 跟 this.view 的初值 'today' 正好相反。
    // 于是应用内部以为在"今日"视图，屏幕上却是一张空画布：
    // 空状态卡片还不显示（它只在 view === 'canvas' 时渲染），
    // 原生分段控件照样高亮"今日"。三处对不上，谁看都像坏了。
    //
    // 现在任何入口进来都先按 this.view 对齐一次显隐。
    $('#vCanvas')!.hidden = this.view !== 'canvas';
    $('#vTl')!.hidden = this.view !== 'tl';
    $('#vLv')!.hidden = this.view !== 'lv';
    $('#vWk')!.hidden = this.view !== 'wk';
    $('#vToday')!.hidden = this.view !== 'today';
    $('#vDetail')!.hidden = this.view !== 'detail';

    // 详情画布：节点被删兜底。库变化（removeNode / import）时栈里可能有死 id，滤掉。
    if (this.detailStack.length) {
      this.detailStack = this.detailStack.filter((s) => this.spaceLib().nodes.some((n) => n.id === s.nodeId));
      if (!this.detailStack.length && this.view === 'detail') {
        this.view = this.preDetailView;
      }
    }
    this.renderTree();
    this.renderLegend();
    this.renderCrumb();
    if (this.view === 'tl') renderTimeline($('#vTl')!, { lib: this.spaceLib(), theme: effectiveTheme(), onPick: (id) => this.pick(id) });
    else if (this.view === 'lv') renderList($('#vLv')!, {
      lib: this.spaceLib(), areaId: this.canvasFocusTheme(),
      focusThemeId: this.canvasFocusTheme(), focusStageId: this.canvasFocusStage(),
      nodeTypes: this.nodeTypes.size ? this.nodeTypes : null,
      filter: this.filter,
      theme: effectiveTheme(),
      onPick: (id) => this.pick(id),
      onDelete: (id) => void this.deleteNode(id),
      onToggleDone: (id, d) => { store.updateNode(id, { done: d }); this.render(); },
    });
    else if (this.view === 'today') renderToday($('#vToday')!, {
      lib: this.spaceLib(), date: this.todayDate, theme: effectiveTheme(),
      onSaveDiary: (i, r) => this.saveDiary(i, r),
      onAddSoft: (txt) => this.addSoft(txt),
      onEditSoft: (id) => { this.editingSoftId = id; this.render(); },
      onCancelEditSoft: () => { if (this.editingSoftId !== null) { this.editingSoftId = null; this.render(); } },
      onUpdateSoft: (id, txt) => this.updateSoft(id, txt),
      onToggleSoft: (id, d) => this.toggleSoft(id, d),
      onDeleteSoft: (id) => void this.deleteSoft(id),
      editingSoftId: this.editingSoftId,
      onPick: (id) => this.pick(id),
      onPrev: () => { this.todayDate = dayShift(this.todayDate, -1); this.editingSoftId = null; this.render(); },
      onNext: () => { this.todayDate = dayShift(this.todayDate, 1); this.editingSoftId = null; this.render(); },
      onToday: () => { this.todayDate = todayKey(); this.editingSoftId = null; this.render(); },
    });
    else if (this.view === 'wk') renderWeekCalendar($('#vWk')!, {
      // ⚠️ 周历要看**所有**周空间的状态 ⇒ 用全库，不按当前空间过滤
      lib: store.lib, month: this.calendarMonth,
      onEnterWeek: (monday) => this.enterWeek(monday),
      onPrevMonth: () => { this.calendarMonth = shiftMonth(this.calendarMonth, -1); this.render(); },
      onNextMonth: () => { this.calendarMonth = shiftMonth(this.calendarMonth, 1); this.render(); },
      onThisMonth: () => { this.calendarMonth = currentMonth(); this.render(); },
    });
    else if (this.view === 'detail') {
      const top = this.detailStack[this.detailStack.length - 1];
      if (top) {
        const lib = this.spaceLib();
        const node = lib.nodes.find((n) => n.id === top.nodeId);
        if (node) {
          const host: DetailHost = {
            lib,
            nodeId: top.nodeId,
            stackDepth: this.detailStack.length,
            stackBreadcrumb: this.detailStack.map((s) => {
              const nn = lib.nodes.find((n) => n.id === s.nodeId);
              return { nodeId: s.nodeId, title: nn?.title ?? '?' };
            }),
            theme: effectiveTheme(),
            onLinkedPick: (id) => this.onLinkedPickFromDetail(id),
            onEditEdge: (eid) => void this.openEdgeEditor(eid),
            onRemoveEdge: (eid) => void this.removeEdgeWithConfirm(eid),
            onGoToSource: (sid) => this.goToSource(sid),
            resolveSource: (id) => store.lib.nodes.find((n) => n.id === id),
            onEdit: (id) => this.onEditFromDetail(id),
            onBack: () => this.popDetail(),
            onJumpTo: (level) => this.onJumpToFromDetail(level),
            onToggleMilestone: (mid, done) => {
              // 详情画布里唯一的写操作。轻量：不入版本历史、不弹原因框
              store.setMilestoneDone(mid, done, todayKey());
              this.render();
              toast(done ? t('toast.markedDone') : t('toast.unchecked'));
            },
          };
          renderDetail($('#vDetail') as HTMLElement, host);
        }
      }
    }
    renderInspector($('#right')!, {
      lib: this.spaceLib(), selectedId: this.selected.values().next().value ?? null,
      onStatus: (id, s, r) => { store.setGoalStatus(id, s, r); toast(t('toast.statusUpdated')); },
      onEditTitle: (id, txt, r) => { store.updateNode(id, { title: txt }, { reason: r }); },
      onMarkMilestone: (id, txt, r) => { store.markMilestone(id, txt, r); toast(t('toast.milestoneMarked')); },
      onRestore: (nid, vid, r) => { store.restoreVersion(nid, vid, r); toast(t('toast.restored')); },
      onToggleDone: (id, d) => { store.updateNode(id, { done: d }); this.render(); },
      onSetImage: (id, data, w, h) => this.setNodeImage(id, data, w, h),
      onPickImage: (cb) => this.pickImage(cb),
      onSetImageUrl: (id, url) => this.setNodeImageUrl(id, url),
      onRemoveImage: (id) => this.removeNodeImage(id),
      onSetLink: (id, url, label) => this.setNodeLink(id, url, label),
      onRemoveLink: (id) => this.removeNodeLink(id),
      onEditContent: (id, c, r) => { store.updateNode(id, { content: c }, { reason: r }); this.render(); },
      onToggleTheme: (id, tid) => this.toggleTheme(id, tid),
      onToggleStage: (id, sid) => this.toggleStage(id, sid),
      onToggleTag: (id, tg) => this.toggleTag(id, tg),
      onAddTag: (id, tg) => this.toggleTag(id, tg),
      onPick: (id) => this.pick(id),
      onDelete: (id) => void this.deleteNode(id),
      onRemoveEdge: (eid) => void this.removeEdgeWithConfirm(eid),
      onEditEdge: (eid) => void this.openEdgeEditor(eid),
      onCreateMilestone: (gid, mt, date) => { store.addMilestone(gid, { title: mt, targetDate: date }); this.render(); toast(t('toast.milestoneAdded')); },
      onUpdateMilestone: (mid, patch) => { store.updateMilestone(mid, patch); this.render(); },
      onDeleteMilestone: (mid) => {
        const m = store.lib.milestones.find((v) => v.id === mid);
        void (async () => {
          if (m && !(await confirmBox(t('action.deleteMilestone'), t('confirm.deleteMilestone', { title: m.title }), t('action.delete')))) return;
          store.removeMilestone(mid);
          this.render();
          toast(t('toast.deleted'));
        })();
      },
      onToggleMilestoneDone: (mid, done, today) => { store.setMilestoneDone(mid, done, today); this.render(); },
      onGoToSource: (sid) => this.goToSource(sid),
      resolveSource: (id) => store.lib.nodes.find((n) => n.id === id),
    });
    if (this.canvas) { this.canvas.rebuildIndex(this.spaceLib()); this.canvas.invalidate(); }
    this.syncFilterUI();
    this.updateStates();
  }

  /** 当前透镜内的全部点 */
  private lens(): typeof store.lib.nodes {
    return applyFilter(this.spaceLib(), this.filter, this.nodeTypes.size ? this.nodeTypes : null);
  }

  /* ---------------- M7+：筛选面板 ---------------- */

  private filterMenu(): void {
    const lib = this.spaceLib();
    const months = monthRange(lib);
    const draft: FilterState = {
      statuses: new Set(this.filter.statuses),
      tags: new Set(this.filter.tags),
      from: this.filter.from, to: this.filter.to,
    };

    void modal({
      title: t('filter.title'), okText: t('action.apply'), cancelText: t('action.cancel'),
      body: (card, done) => {
        /* 状态 */
        const g1 = el('div', { class: 'fgroup' });
        const t1 = el('div', { class: 'fgroup-t' }, t('field.status'));
        const c1 = el('button', { class: 'clear' }, t('action.clear'));
        c1.onclick = () => { draft.statuses.clear(); g1.querySelectorAll('.fchip').forEach((x) => x.classList.remove('on')); };
        t1.append(c1); g1.append(t1);
        const chips1 = el('div', { class: 'fchips' });
        for (const st of allStatuses(lib)) {
          if (st === '无目标') continue;
          const b = el('button', { class: 'fchip' + (draft.statuses.has(st) ? ' on' : '') }, statusLabel(st));
          b.onclick = () => {
            draft.statuses.has(st) ? draft.statuses.delete(st) : draft.statuses.add(st);
            b.classList.toggle('on');
          };
          chips1.append(b);
        }
        g1.append(chips1);
        card.append(g1);

        /* 标签 */
        const g2 = el('div', { class: 'fgroup' });
        const t2 = el('div', { class: 'fgroup-t' }, t('field.tags'));
        const c2 = el('button', { class: 'clear' }, t('action.clear'));
        c2.onclick = () => { draft.tags.clear(); g2.querySelectorAll('.fchip').forEach((x) => x.classList.remove('on')); };
        t2.append(c2); g2.append(t2);
        const chips2 = el('div', { class: 'fchips' });
        const tags = allTags(lib);
        if (!tags.length) chips2.append(el('span', { class: 'fchip', style: 'opacity:.5;cursor:default' }, t('empty.noTags')));
        for (const { name, count } of tags) {
          const b = el('button', { class: 'fchip' + (draft.tags.has(name) ? ' on' : '') });
          b.append(name, el('span', { class: 'n' }, String(count)));
          b.onclick = () => {
            draft.tags.has(name) ? draft.tags.delete(name) : draft.tags.add(name);
            b.classList.toggle('on');
          };
          chips2.append(b);
        }
        g2.append(chips2);
        card.append(g2);

        /* 时间 */
        const g3 = el('div', { class: 'fgroup' });
        const t3 = el('div', { class: 'fgroup-t' }, t('field.time'));
        const c3 = el('button', { class: 'clear' }, t('common.any'));
        c3.onclick = () => {
          draft.from = ''; draft.to = '';
          (fromSel as HTMLSelectElement).value = ''; (toSel as HTMLSelectElement).value = '';
        };
        t3.append(c3); g3.append(t3);
        const range = el('div', { class: 'frange' });
        const fromSel = el('select') as HTMLSelectElement;
        const toSel = el('select') as HTMLSelectElement;
        for (const sel of [fromSel, toSel]) {
          const o0 = el('option', {}, t('common.any')) as HTMLOptionElement;
          o0.value = ''; sel.append(o0);
          for (const m of months) { const o = el('option', {}, m) as HTMLOptionElement; o.value = m; sel.append(o); }
        }
        fromSel.value = draft.from; toSel.value = draft.to;
        fromSel.onchange = () => { draft.from = fromSel.value; };
        toSel.onchange = () => { draft.to = toSel.value; };
        range.append(fromSel, el('span', { class: 'to' }, '→'), toSel);
        g3.append(range);
        g3.append(el('p', { class: 'fnote' }, t('help.nodesWithoutTime')));
        card.append(g3);

        // 预览：应用后还剩多少个点
        const prev = el('p', { class: 'fnote', style: 'margin-top:12px' });
        const update = () => {
          const n = applyFilter(lib, draft, this.nodeTypes.size ? this.nodeTypes : null).length;
          prev.innerHTML = t('toast.appliedCount', {
            n: `<b style="color:var(--accent)">${n}</b>`,
            total: lib.nodes.length,
          });
        };
        card.addEventListener('click', () => setTimeout(update, 0));
        update();
        card.append(prev);
        void done;
      },
      onOk: () => {
        // from > to 时自动对调，别给用户一个永远空的结果
        if (draft.from && draft.to && draft.from > draft.to) {
          const x = draft.from; draft.from = draft.to; draft.to = x;
          toast(t('error.timeRangeSwapped'));
        }
        this.filter = draft;
        this.syncFilterUI();
        this.reapplySearch();
        this.render();
      },
    });
  }

  /** 筛选变化后重跑当前搜索，让高亮落在透镜内 */
  private reapplySearch(): void {
    const q = this.query;
    if (!q) { this.updateStates(); return; }
    void this.runSearch(q);
  }

  private syncFilterUI(): void {
    const n = filterCount(this.filter);
    emit('filterChanged', { n });
    const badge = $('#filterBadge')!;
    badge.textContent = String(n);
    badge.hidden = n === 0;
    $('#btnFilter')!.classList.toggle('acc', n > 0);
    const sum = $('#filterSummary')!;
    if (!isFilterActive(this.filter)) {
      sum.innerHTML = t('filter.none');
    } else {
      sum.innerHTML = describeFilter(this.filter).map((d) => `<b>${escapeHtml(d)}</b>`).join('<br>')
        + `<br><span class="muted">${t('canvas.nodeCount', { a: this.lens().length, b: this.spaceLib().nodes.length })}</span>`;
    }
  }

  private renderTree(): void {
    const lib = this.spaceLib();
    const treeTheme = $('#treeTheme')!;
    const treeStage = $('#treeStage')!;
    treeTheme.innerHTML = '';
    treeStage.innerHTML = '';
    // 周画布里**不能**新建主题/阶段 —— 主题阶段是全局共用的，在主画布建。
    // 这里只是把入口藏起来；真要防住还得看 addTheme/addStage 有没有校验空间。
    const treeAct = document.querySelector('.tree-act') as HTMLElement | null;
    if (treeAct) treeAct.hidden = store.currentSpaceId !== MAIN_SPACE;

    /* 主题（树形） */
    const hasParent = new Set(lib.themes.map((th) => th.parentId).filter(Boolean) as string[]);
    const roots = lib.themes.filter((th) => !hasParent.has(th.id));
    /** 父主题的数字只算"themeIds 直接含自己"的节点（不含子主题）—— 子主题的合计另算 */
    const directCountOf = (th: typeof roots[number]): number =>
      lib.nodes.filter((n) => n.themeIds.includes(th.id) && (!this.stageId || inStage(lib, n, this.stageId))).length;
    const addThemeRow = (th: typeof roots[number], lv: number) => {
      const inside = directCountOf(th);
      const row = el('div', { class: 'tnode' + (lv ? ' lv' + Math.min(lv, 1) : '') + (this.themeId === th.id ? ' on' : ''), draggable: 'true' });
      const sw = el('span', { class: 'sw' }); sw.style.background = th.color;
      const x = el('span', { class: 'x', title: t('action.deleteThemeKeepNodes') }, '×');
      x.onclick = async (ev) => {
        ev.stopPropagation();
        const msg = inside > 0
          ? t('confirm.deleteThemeWithNodes', { name: th.name, n: inside })
          : t('confirm.deleteTheme', { name: th.name });
        if (!(await confirmBox(t('action.deleteTheme'), msg, t('action.delete')))) return;
        store.removeTheme(th.id);
        if (this.themeId === th.id) this.setFocus(null, this.stageId);
        this.render();
        toast(t('theme.deleted', { name: th.name }));
      };
      row.append(sw, el('span', { class: 'nm' }, th.name),
        el('span', { class: 'ct' }, String(inside)),
        x);
      row.onclick = () => this.setFocus(this.themeId === th.id ? null : th.id, this.stageId);
      row.oncontextmenu = (ev) => { ev.preventDefault(); this.showThemeMenu(ev, th, x); };

      /* 拖拽：把主题 id 放进 dataTransfer，drop 在某行/容器上时改 parentId */
      row.addEventListener('dragstart', (ev) => {
        ev.dataTransfer?.setData('text/x-theme-id', th.id);
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); treeTheme.classList.remove('drop-bg'); });
      row.addEventListener('dragover', (ev) => {
        if (!ev.dataTransfer?.types.includes('text/x-theme-id')) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        row.classList.add('drop-on');
      });
      row.addEventListener('dragleave', () => { row.classList.remove('drop-on'); });
      row.addEventListener('drop', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.remove('drop-on');
        const dragged = ev.dataTransfer?.getData('text/x-theme-id');
        if (dragged) this.reparentTheme(dragged, th.id);
      });

      treeTheme.append(row);
      for (const c of lib.themes.filter((x) => x.parentId === th.id)) addThemeRow(c, lv + 1);
    };
    roots.forEach((r) => addThemeRow(r, 0));
    if (!roots.length) treeTheme.append(el('div', { style: 'font-size:11.5px;color:var(--faint);padding:6px 8px' }, t('empty.noThemes')));
    $('#themeCount').textContent = t('common.count', { n: lib.themes.length });

    /* 主题容器空白处也接受 drop → 置顶级（parentId = null） */
    treeTheme.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer?.types.includes('text/x-theme-id')) return;
      if ((ev.target as HTMLElement).closest('.tnode')) return; // 行内 drop 由各行自己处理
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      treeTheme.classList.add('drop-bg');
    });
    treeTheme.addEventListener('dragleave', (ev) => {
      if (ev.target === treeTheme) treeTheme.classList.remove('drop-bg');
    });
    treeTheme.addEventListener('drop', (ev) => {
      if ((ev.target as HTMLElement).closest('.tnode')) return;
      ev.preventDefault();
      treeTheme.classList.remove('drop-bg');
      const dragged = ev.dataTransfer?.getData('text/x-theme-id');
      if (dragged) this.reparentTheme(dragged, null);
    });

    /* 阶段（平级，按 end 倒序） */
    const stages = [...lib.stages].sort((a, b) => (b.end ?? '').localeCompare(a.end ?? ''));
    for (const s of stages) {
      const inside = visibleNodesByFocus(lib, this.themeId, s.id).length;
      const dateStr = s.start || s.end ? `${s.start ?? '…'} → ${s.end ?? '…'}` : t('common.noDates');
      const row = el('div', { class: 'tnode stage' + (this.stageId === s.id ? ' on' : '') });
      const sw = el('span', { class: 'sw' }); sw.style.background = s.color;
      const x = el('span', { class: 'x', title: t('action.deleteThisStage') }, '×');
      x.onclick = async (ev) => {
        ev.stopPropagation();
        const msg = inside > 0
          ? t('confirm.deleteStageWithNodes', { name: s.name, n: inside })
          : t('confirm.deleteStage', { name: s.name });
        if (!(await confirmBox(t('action.deleteStage'), msg, t('action.delete')))) return;
        store.removeStage(s.id);
        if (this.stageId === s.id) this.setFocus(this.themeId, null);
        this.render();
        toast(t('stage.deleted', { name: s.name }));
      };
      row.append(sw, el('span', { class: 'nm' }, s.name),
        el('span', { class: 'dt' }, dateStr),
        el('span', { class: 'ct' }, String(inside)),
        x);
      row.onclick = () => this.setFocus(this.themeId, this.stageId === s.id ? null : s.id);
      row.oncontextmenu = (ev) => { ev.preventDefault(); void x.click(); };
      treeStage.append(row);
    }
    if (!stages.length) treeStage.append(el('div', { style: 'font-size:11.5px;color:var(--faint);padding:6px 8px' }, t('empty.noStages')));
    $('#stageCount').textContent = t('common.count', { n: lib.stages.length });

    const lc = $('#lockState');
    if (lc) lc.textContent = this.sessionKey ? t('crypto.encryptedTag') : t('crypto.notEncryptedTag');
  }

  /**
   * 图例：点类型 / 连线类型两排 chip。
   *
   * ⚠️ **只建一次，之后只换文字**：
   *   早期写法是 `if (lgType.childElementCount) return;` —— 建完就再也不碰了。
   *   但 chip 上的字是 t() 出来的**显示名**，切语言时必须跟着换，
   *   不换的话界面上就是"标题英文、chip 中文"的分裂（用户实际报的就是这个）。
   *
   *   所以拆成两步：结构建一次（事件绑定、色块、.on 高亮都靠它），
   *   文字由 refreshLegendText() 每次 render 时刷一遍。
   */
  private renderLegend(): void {
    const lgType = $('#lgType')!;
    if (lgType.childElementCount) {
      this.refreshLegendText();
      return;
    }
    for (const ty of NODE_TYPES) {
      const b = el('span', { class: 'lg' });
      const sw = el('span', { class: 'sw' });
      sw.style.background = NODE_TYPE_COLOR[ty];
      b.append(sw, document.createTextNode(nodeTypeLabel(ty)));
      b.onclick = () => {
        this.nodeTypes.has(ty) ? this.nodeTypes.delete(ty) : this.nodeTypes.add(ty);
        this.syncTypeLegend();
        this.render();
      };
      lgType.append(b);
    }
    const e = $('#lgEdge')!;
    for (const ty of EDGE_TYPES) {
      if (ty === 'belong') continue;
      const b = el('span', { class: 'lg' + (this.edgeType === ty ? ' on' : '') });
      const sw = el('span', { class: 'sw' });
      sw.style.background = EDGE_TYPE_COLOR[ty];
      b.append(sw, document.createTextNode(edgeTypeLabel(ty)));
      b.onclick = () => { this.edgeType = ty; e.querySelectorAll('.lg').forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
      e.append(b);
    }
  }

  /**
   * 把图例 chip 上的文字刷成当前语言。
   *
   * ⚠️ 靠**顺序**对应，不是靠 id：
   *   点类型那一排的顺序 = NODE_TYPES 的顺序（建的时候就是那么 append 的），
   *   连线类型那一排 = EDGE_TYPES 去掉 belong 之后的顺序。
   *   这跟 syncTypeLegend() 用下标对 NODE_TYPES 的做法是同一套约定。
   */
  private refreshLegendText(): void {
    const typeEls = $('#lgType')!.querySelectorAll('.lg');
    NODE_TYPES.forEach((ty, i) => {
      const e = typeEls[i];
      if (e) e.childNodes[1]!.textContent = nodeTypeLabel(ty);
    });
    const edgeEls = $('#lgEdge')!.querySelectorAll('.lg');
    let j = 0;
    for (const ty of EDGE_TYPES) {
      if (ty === 'belong') continue;
      const e = edgeEls[j++];
      if (e) e.childNodes[1]!.textContent = edgeTypeLabel(ty);
    }
  }

  private renderCrumb(): void {
    const c = $('#crumb')!;
    if (!this.themeId && !this.stageId) { c.textContent = t('filter.all'); return; }
    c.innerHTML = focusPath(store.lib, this.themeId, this.stageId)
      .split('·').map((s) => `<b>${s.trim()}</b>`).join(' · ');
  }

  /** 设置焦点（多维）。唯一入口，所有视图从这里派生。 */
  setFocus(themeId: string | null, stageId: string | null): void {
    this.themeId = themeId;
    this.stageId = stageId;
    if (this.sideTimer) { clearTimeout(this.sideTimer); this.sideTimer = null; }
    this.render();
    const nodes = visibleNodesByFocus(this.spaceLib(), themeId, stageId);
    if (this.canvas) this.canvas.fit(nodes.map((n) => n.id), (themeId || stageId) ? 1.15 : 0.9);
  }

  /** @deprecated 旧单焦点入口；保留为 setFocus 兜底直至 Phase 9 */
  setArea(id: string | null): void { this.setFocus(id, this.stageId); }

  /**
   * 重置画布：把"看东西的状态"一次性清回原样，**数据一个字节都不动**。
   *
   * 用户的场景：在左栏点了某个主题/阶段（或者搜了东西、筛了状态），
   * 画布就只剩那一小块；想回到全局视角只能退出应用重开。
   * 这个动作就是那个"退出重开"的轻量版 —— 状态归零，但不碰库里任何一条记录。
   *
   * 清掉的（都是"看"的维度）：
   *   焦点（主题/阶段）· 筛选（状态/标签/时间）· 搜索 · 选中 · 点类型筛选 · 缩放位置
   *
   * ⚠️ 两处容易漏掉的联动：
   *   ① 图例高亮（点类型筛选）是**手动**加的 .on 类，render 不会重建它
   *      —— 只清 nodeTypes 会留下"图例还亮着、实际没筛"的分裂状态。
   *   ② 搜索框的输入框值 + 原生搜索框：清 query 不够，两边的框都得空。
   */
  private resetCanvasView(): void {
    // 焦点：主题和阶段都清掉 → 回到"全部"
    this.themeId = null;
    this.stageId = null;

    // 筛选透镜
    this.filter = emptyFilter();

    // 搜索：走 setQuery —— 它是搜索的唯一入口，会同时清掉
    // web 的输入框、命中集、关系上下文集，并 emit 给原生搜索框。
    // ⚠️ 手动只清 this.query 是不够的：两个输入框里还留着字，
    //    下次输入会变成「旧词+新词」，原生那边也会显示旧词。
    this.setQuery('');

    // 选中：点 + 关系
    this.selected.clear();
    this.selectedEdgeId = null;

    // 点类型筛选 + 图例高亮（见上面的 ①）
    this.nodeTypes.clear();
    this.syncTypeLegend();

    // 侧栏 / 检视面板 / 筛选摘要全部重画（render 里会调 syncFilterUI）
    this.render();

    // 视口：回到全局视角（焦点已清空 → 可见的就是全库）。
    //
    // ⚠️ 画布此刻若是隐藏的（从原生菜单触发时可能在列表/时间轴视图），
    //    它的尺寸是 0×0 —— 此刻 fit 会按 0 宽算出离谱的缩放。
    //    所以：不在画布视图就先切过去，等两次 rAF 让布局落定再 fit。
    const goGlobal = (): void => {
      const ns = visibleNodesByFocus(this.spaceLib(), null, null);
      // ⚠️ 「已定位」必须等于"真的定位上了"：fit 失败（空库 / 视口还没尺寸）
      //    就把标记退回去，等下次真能定位时重来。占着标记的话，
      //    画布会永远停在一个没定位的状态：画面空白、缩放停在 100%。
      if (this.canvas.fit(ns.map((n) => n.id), 0.9)) {
        this.canvasPositioned = true;
      } else {
        this.canvasPositioned = false;
      }
    };
    if (this.view !== 'canvas') {
      this.switchView('canvas');
      requestAnimationFrame(() => requestAnimationFrame(goGlobal));
    } else {
      goGlobal();
    }

    toast(t('toast.canvasReset'));
  }

  /**
   * 点类型图例的高亮同步。
   *
   * ⚠️ 为什么单独抽出来：图例的 .on 类是点击时**手动**加的，
   *    render() 不会重建图例（renderLegend 见到已有子元素就早退）——
   *    所以任何不是"点击图例"路径改 nodeTypes 的地方（重置），
   *    都必须自己把高亮抹掉，否则界面和状态对不上。
   */
  private syncTypeLegend(): void {
    const lgType = $('#lgType');
    if (!lgType) return;
    lgType.querySelectorAll('.lg').forEach((x, i) => {
      x.classList.toggle('on', this.nodeTypes.has(NODE_TYPES[i]!));
    });
  }

  private pick(id: string): void {
    this.selected = new Set([id]);
    if (this.sideTimer) { clearTimeout(this.sideTimer); this.sideTimer = null; }
    this.switchView('canvas');
    this.canvas.centerOn(id);
    this.render();
  }

  /* ---------------- 详情画布（栈式） ---------------- */

  /**
   * 把节点压入详情栈并切到 detail 视图。
   * 仅 goal + action 可入栈（产品决定 —— 见 plan §"MVP 切片"）。
   * 已在栈中 → no-op，避免循环。
   */
  pushDetail(nodeId: string): void {
    const n = store.lib.nodes.find((x) => x.id === nodeId);
    if (!n || (n.type !== 'goal' && n.type !== 'action')) return;
    if (this.detailStack.some((s) => s.nodeId === nodeId)) return;
    this.detailStack.push({ nodeId });
    if (this.view !== 'detail') {
      this.preDetailView = this.view;
      this.switchView('detail');
    } else {
      this.render();
    }
  }

  /** ← 返回 / Esc 路径。栈 pop 到空时回到 preDetailView */
  popDetail(): void {
    if (!this.detailStack.length) return;
    this.detailStack.pop();
    if (!this.detailStack.length) this.switchView(this.preDetailView);
    else this.render();
  }

  /** 切换视图 / 解锁 / 显式清栈时调用 */
  clearDetailStack(): void {
    this.detailStack = [];
  }

  /** ✎ 编辑：退栈 + 选中 + 切回主画布；把视口对准到该节点 */
  onEditFromDetail(id: string): void {
    this.clearDetailStack();
    this.preDetailView = 'canvas';
    this.switchView('canvas');
    this.selected = new Set([id]);
    if (this.sideTimer) { clearTimeout(this.sideTimer); this.sideTimer = null; }
    this.canvas.centerOn(id);
    this.render();
  }

  /**
   * 关联节点点击：goal/action → push（继续钻取），其它 → 退栈 + 选中 + 切回主画布
   * 这样 goal↔action 之间可以一路钻下去，点到 event/idea/theme/stage 就回主画布
   */
  onLinkedPickFromDetail(id: string): void {
    const n = store.lib.nodes.find((x) => x.id === id);
    if (n && (n.type === 'goal' || n.type === 'action')) {
      this.pushDetail(id);
      return;
    }
    this.clearDetailStack();
    this.preDetailView = 'canvas';
    this.switchView('canvas');
    this.selected = new Set([id]);
    if (this.sideTimer) { clearTimeout(this.sideTimer); this.sideTimer = null; }
    if (n) this.canvas.centerOn(id);
    this.render();
  }

  /** 面包屑跳层：截断栈尾，重渲。栈本身已经是 push-only，slice 是最直白的语义 */
  onJumpToFromDetail(level: number): void {
    if (level < 0 || level >= this.detailStack.length) return;
    this.detailStack = this.detailStack.slice(0, level + 1);
    this.render();
  }

  /**
   * 进那一周的复盘画布：切空间 → 切到画布视图 → 相机落到那一周的内容上。
   *
   * 空间是空的（第一次进这一周）⇒ 相机落到原点。
   * 不这么做的话，用户进到一张空画布、眼前却是上一次的视图，
   * 会以为"怎么什么都没有"。
   */
  private enterWeek(monday: string): void {
    this.gotoSpace(weekSpaceId(monday), true);
  }

  /** 回到主画布（从周画布出来）。 */
  private backToMain(): void {
    this.gotoSpace(MAIN_SPACE, true);
  }

  /* ============================================================
   * 阶段三：周画布 —— 空间切换 / 回原文 / 引入原数据
   * ============================================================ */

  /**
   * 切到某个空间（主画布 / 某个周画布）。
   *
   * 相机落到那个空间的内容上；空空间落到原点 ——
   * 否则进到一张空画布、眼前却是上一次的视图，会以为"怎么什么都没有"。
   *
   * force=true 是"重新进同一个空间"（周历里再点一次同一周）：这时也要重新定位。
   */
  private gotoSpace(spaceId: string, force = false): void {
    if (!force && store.currentSpaceId === spaceId) { this.render(); return; }
    store.currentSpaceId = spaceId;
    // 选中集合里不属于新空间的点要丢掉 ——
    // 不丢的话，右侧检视面板会显示"该点已被删除"（它在别的空间好好的），
    // 用户会以为自己的数据被删了。
    const ids = new Set(this.spaceLib().nodes.map((n) => n.id));
    if (this.selected.size) this.selected = new Set([...this.selected].filter((id) => ids.has(id)));
    this.switchView('canvas');
    const ids2 = this.spaceLib().nodes.map((n) => n.id);
    requestAnimationFrame(() => {
      if (!this.canvas) return;
      if (ids2.length) this.canvas.fit(ids2);
      else this.canvas.panTo(0, 0);
    });
  }

  /**
   * 回原文 —— 从周画布里的副本跳回主画布的原件。
   *
   * ★ 必须按 id 全库找：副本在周空间、原件在主空间，
   *   拿当前空间的视图查是查不到的（id 全局唯一，所以全库查一次就够）。
   */
  private goToSource(sourceId: string): void {
    const src = store.lib.nodes.find((n) => n.id === sourceId);
    if (!src) { toast(t('week.sourceGone')); return; }
    store.currentSpaceId = src.spaceId;
    // 明确要落在那个点上 ⇒ 画布算"已定位"。
    // 不置这个标记的话，首次定位（双 rAF 之后 fit）会把它拽走，表现为"跳过去又弹回来"。
    this.canvasPositioned = true;
    this.switchView('canvas');
    requestAnimationFrame(() => {
      if (this.canvas) this.canvas.centerOn(src.id);
    });
  }

  /** 空间下拉：主画布 + 所有有内容的周空间（最近的在前）+ 周历入口 */
  private renderSpaceMenu(): void {
    const menu = $('#spaceMenu');
    if (!menu) return;
    menu.innerHTML = '';
    const cur = store.currentSpaceId;

    menu.append(el('div', { class: 'mh' }, t('week.space')));
    const main = el('button', { class: 'mi' + (cur === MAIN_SPACE ? ' on' : '') }, spaceTitle(MAIN_SPACE));
    main.append(el('span', { class: 'sub' }, t('list.allRecords')));
    main.onclick = () => { this.closeSpaceMenu(); this.gotoSpace(MAIN_SPACE); };
    menu.append(main);

    // 周画布：只列有内容的（空周画布还没开始写，列出来只是噪音）
    const stats = weekSpaceStats(store.lib);
    const weeks = weekSpaces(store.lib).reverse();       // 最近的在前
    if (weeks.length) {
      menu.append(el('div', { class: 'mh' }, t('view.weekCanvas')));
      for (const w of weeks) {
        const cnt = stats.get(w.spaceId)?.count ?? 0;
        const b = el('button', { class: 'mi' + (cur === w.spaceId ? ' on' : '') }, `${w.label} · ${w.range}`);
        b.append(el('span', { class: 'sub' }, t('common.nodeCount', { n: cnt })));
        b.onclick = () => { this.closeSpaceMenu(); this.gotoSpace(w.spaceId); };
        menu.append(b);
      }
    }

    menu.append(el('div', { class: 'sep' }));
    const cal = el('button', { class: 'mi' }, t('view.weekCalendarEllipsis'));
    cal.append(el('span', { class: 'sub' }, t('week.seeAllPickOne')));
    cal.onclick = () => { this.closeSpaceMenu(); this.switchView('wk'); };
    menu.append(cal);
  }

  private toggleSpaceMenu(): void {
    const menu = $('#spaceMenu');
    if (!menu) return;
    if (menu.hidden) { this.renderSpaceMenu(); menu.hidden = false; }
    else menu.hidden = true;
  }

  private closeSpaceMenu(): void {
    const menu = $('#spaceMenu');
    if (menu) menu.hidden = true;
  }

  /**
   * 引入本周原数据 —— 把主画布上这一周的记录复制进这一周的复盘画布。
   *
   * ★ 是复制不是引用：副本与原件从此分叉（上周当时的理解就该定格）。
   * ★ 软件只做「捞、摆」—— 它不生成任何总结文字，勾什么引什么。
   */
  private async importWeekData(): Promise<void> {
    const w = parseWeekSpace(store.currentSpaceId);
    if (!w) return;
    const cands = weekSourceCandidates(store.lib, w.monday);
    if (!cands.length) {
      toast(t('week.noRecordsInRange', { range: w.range }));
      return;
    }
    const picked = new Set(cands.map((n) => n.id));
    const r = await modal({
      title: t('week.pullInWeekDataWithRange', { range: w.range }),
      okText: t('week.pullIn'),
      wide: true,
      body: (card) => {
        card.append(el('p', { class: 'hint', style: 'margin:0 0 10px' },
          t('week.pullInExplain')));
        for (const day of weekDays(w.monday)) {
          const list = cands.filter((n) => nodeDay(n) === day);
          if (!list.length) continue;
          const sec = el('div', { class: 'imp-day' });
          sec.append(el('div', { class: 'imp-day-h' }, t('list.dayCount', { day: dayLabel(day), n: list.length })));
          for (const n of list) {
            const row = el('label', { class: 'imp-row' });
            const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
            cb.checked = true;
            cb.onchange = () => { if (cb.checked) picked.add(n.id); else picked.delete(n.id); };
            row.append(cb);
            row.append(el('span', { class: 'imp-t' }, n.title || t('common.noTitle')));
            row.append(el('span', { class: 'imp-m' }, t('node.typeTime', {
              type: nodeTypeLabel(n.type),
              time: n.time ?? t('common.noDate'),
            })));
            sec.append(row);
          }
          card.append(sec);
        }
      },
      onOk: () => {
        if (!picked.size) { toast(t('milestone.tickAtLeastOne')); return false; }
        return true;
      },
    });
    if (r === null) return;
    const chosen = cands.filter((n) => picked.has(n.id));
    // 落在周空间已有内容**下面** —— 引入的副本不许压在自己写的点上
    const payloads = buildWeekImports(chosen, w.monday, store.currentSpaceId, this.weekImportOrigin());
    for (const p of payloads) store.addNode(p);
    this.render();
    // 镜头跟过去：刚引进来的东西得看得见（那一周的横线可能横在屏幕外）
    const ids = this.spaceLib().nodes.map((n) => n.id);
    requestAnimationFrame(() => {
      if (this.canvas && ids.length) this.canvas.fit(ids);
    });
    toast(t('toast.pulledIn', { n: payloads.length }));
  }

  /**
   * 引入副本的落点：x 从 60 起（周一对齐左边），y 落在周空间现有内容下面。
   *
   * 为什么不在原点起排：周画布里可能已经写了几条 —— 副本压在它们上面，
   * 一点没写东西的人看着像"我的记录被复制品盖住了"。
   */
  private weekImportOrigin(): { x: number; y: number } {
    let bottom = 0;
    for (const n of this.spaceLib().nodes) bottom = Math.max(bottom, n.y + n.h);
    return { x: 60, y: bottom > 0 ? bottom + 60 : 60 };
  }

  /**
   * 生成复盘卡片 —— 把这一周挑几个点，排成一张 3:4 的竖版长图。
   *
   * 画布上选中的点先勾上；一个都没选就把这一周的都放上（用户自己删）。
   * ★ 卡片上的每个字都是用户自己写的 —— 这里只做「挑 / 排 / 渲染」。
   */
  private async openReviewCard(): Promise<void> {
    const w = parseWeekSpace(store.currentSpaceId);
    if (!w) { toast(t('onboard.stepWeek')); return; }
    const nodes = this.spaceLib().nodes;
    if (!nodes.length) { toast(t('week.nothingWritten')); return; }
    const presetIds = [...this.selected].filter((id) => nodes.some((n) => n.id === id));
    await openReviewCardPanel({
      candidates: nodes,
      presetIds,
      weekLabel: w.label,
      rangeText: w.range,
      theme: this.cardTheme(),
      showFooter: true,
      onDownload: (canvas) => void this.downloadReviewCard(canvas, w.weekNo),
    });
  }

  /** 卡片的配色：跟当前主题走（亮色/高对比/暗色） */
  private cardTheme(): CardTheme {
    if (effectiveTheme() === 'light') return 'light';
    return this.settings.contrast === 'high' ? 'high' : 'dark';
  }

  /** 导出复盘卡片 PNG */
  private async downloadReviewCard(canvas: HTMLCanvasElement, weekNo: number): Promise<void> {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) { toast(t('error.exportFailed')); return; }
    download(`life-canvas-week${weekNo}.png`, blob, 'image/png');
    toast(t('toast.exportedReady'));
  }

  private switchView(v: View): void {
    // 切视图顺手收起空间下拉 —— 菜单是浮在画布上的，留着会挡住新视图
    this.closeSpaceMenu();
    // 从详情栈切走（seg 按钮 / 快捷键 1-4）→ 清栈，避免下次进栈时混入老节点
    if (this.view === 'detail' && v !== 'detail') this.clearDetailStack();
    this.view = v;
    $('#seg')!.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.v === v));
    // 视图显隐由 render() 按 this.view 统一处理，这里不重复设 hidden
    this.render();
    emit('viewChanged', { view: v });
    this.positionCanvasOnce();
  }

  /**
   * 第一次进画布 → 定位到当前焦点（阶段/主题）并自适应。只做一次。
   *
   * ⚠️ 为什么必须等"第一次切到画布"：启动时画布是**隐藏**的（默认停在今日视图），
   *    隐藏元素的 getBoundingClientRect() 是 0×0 —— 那时算 fit 只会得到
   *    MIN_SCALE(8%) 和一个错位的视口。之前"开局落在最近阶段"的意图
   *    就是落在这里的，只是**只设了焦点没定位**，用户看到的是世界的一角。
   *
   * ⚠️ 为什么"已定位"标记要**定位成功之后**才置位：
   *    原生外壳会在 web 还在读库的时候就把视图切过来（原生分段控件先动了，
   *    web 的 CanvasView 还没建好）。这时 fit 根本跑不了 ——
   *    但标记已经被用掉了，于是画布永远停在"没定位"的状态：
   *    画面上一片空白，缩放读数停在 100%，而点其实都在。
   *    跑不了就把标记退回去，等下次真的能定位时重来。
   *
   * 只做一次：之后用户自己平移缩放过，再切视图不该被拽回去。
   */
  private positionCanvasOnce(): void {
    if (this.canvasPositioned || !this.canvas) return;
    this.canvasPositioned = true;
    // 等一帧：render() 刚把画布显示出来，尺寸要落定才知道怎么 fit
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // 两次 rAF 之后画布仍可能不可见（门禁还没放行 / 视图还没切过来）
      if (!this.canvas || this.view !== 'canvas') {
        this.canvasPositioned = false;
        return;
      }
      const ns = visibleNodesByFocus(this.spaceLib(), this.canvasFocusTheme(), this.canvasFocusStage());
      // 装不下就退回去 —— 「已定位」必须等于"真的定位上了"。
      // 空点集（库还没读进来）fit 会失败，这时候占着标记，
      // 画布就永远停在一个没定位的状态：画面空白、缩放停在 100%。
      if (!this.canvas.fit(ns.map((n) => n.id), (this.themeId || this.stageId) ? 1.15 : 0.9)) {
        this.canvasPositioned = false;
      }
    }));
  }

  /* ---------------- 今日视图 ---------------- */

  /** 保存意图/复盘：若该日已存在 reflect 就更新，否则新建一条。理由写"今日视图保存" */
  private saveDiary(intent: string, review: string): void {
    const today = todayNodes(this.spaceLib(), this.todayDate);
    const sep = intent && review ? '\n\n' : '';
    const content = `${t('today.intentHeading')}\n${intent}${sep}${t('today.reviewHeading')}\n${review}`;
    const reason = t('today.viewSave');
    if (today.diary) {
      store.updateNode(today.diary.id, { content }, { reason });
      store.flushVersion(today.diary.id, { reason });
      toast(review ? t('toast.reflectUpdated') : intent ? t('toast.intentSaved') : t('toast.cleared'));
    } else {
      // 没有任何内容就不建空节点
      if (!intent && !review) { toast(t('error.emptyContentNoNode')); return; }
      const d = new Date(this.todayDate + 'T12:00');
      const title = fmtMonthDay(d);
      const pos = this.nextFreePos(this.todayDate);
      store.addNode({
        type: 'reflect', title, time: this.todayDate, content,
        tags: ['日记'],
        x: pos.x, y: pos.y, w: 280, h: 128,
      });
      toast(review ? t('toast.reflectFiled') : t('toast.intentSaved'));
    }
  }

  /** 新增软安排：直接 addNode 一条 action 节点，time=今天。
   *  即使用户浏览到昨天/明天，"+"加入"也会落到今天 —— 软安排 = 今日计划 */
  private addSoft(title: string): void {
    const today = todayKey();
    this.spreadStuckToday(today);
    const pos = this.nextFreePos(today);
    // 软安排继承当前主题/阶段焦点 —— 否则新建出来就是"无主题/无阶段"，检视面板会显得很空
    const themeIds = this.themeId ? [this.themeId] : [];
    const stageIds = this.stageId ? [this.stageId] : [];
    store.addNode({
      type: 'action', title, time: today, content: '',
      tags: [],
      themeIds, stageIds,
      x: pos.x, y: pos.y, w: 280, h: 78,
    });
    toast(t('toast.added'));
  }

  /**
   * 找一个不重叠的落点。优先级：
   * 1) 已有同时间节点 → 接着最后一个往下排（同列）
   * 2) 否则在画布当前最右下角（避开 (0,0) 这种"原点头"）
   * 3) 实在没数据 → 从 (60, 60) 起步
   */
  private nextFreePos(forTime?: string): { x: number; y: number } {
    const lib = this.spaceLib();
    if (forTime) {
      const same = lib.nodes.filter((n) => n.time === forTime);
      if (same.length) {
        // 挑 y 最大（最后一行），同 y 时挑 x 最大
        const last = same.reduce((a, b) => (b.y > a.y || (b.y === a.y && b.x > a.x) ? b : a));
        return { x: last.x, y: last.y + last.h + 18 };
      }
    }
    // 兜底：取现有最右下角
    let maxX = 60, maxY = 60;
    for (const n of lib.nodes) {
      if (n.x === 0 && n.y === 0) continue; // 忽略旧的"叠在一起"的占位
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    return { x: maxX + 40, y: maxY + 40 };
  }

  /**
   * 把"叠在 (0,0)"的同时间节点（早期 bug 留下的）一次性散开到画布右下角。
   * 仅当 ≥ 2 个时才动作 —— 避免无意义地搬动单点。
   */
  private spreadStuckToday(forTime: string): void {
    const lib = this.spaceLib();
    const stuck = lib.nodes.filter((n) => n.time === forTime && n.x === 0 && n.y === 0);
    if (stuck.length < 2) return;
    let maxX = 60, maxY = 60;
    for (const n of lib.nodes) {
      if (n.x === 0 && n.y === 0) continue;
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    let y = maxY + 40;
    for (const n of stuck) {
      store.moveNode(n.id, maxX + 40, y);
      y += n.h + 16;
    }
  }

  /** 改一条软安排的 title：空标题视作删除 */
  private updateSoft(id: string, title: string): void {
    const n = store.lib.nodes.find((x) => x.id === id);
    if (!n) { this.editingSoftId = null; this.render(); return; }
    if (!title) {
      // 空标题直接走删除路径（用户把标题全删了）
      this.editingSoftId = null;
      store.removeNode(id);
      this.render();
      toast(t('toast.titleEmptyDeleted'));
      return;
    }
    if (title === n.title) { this.editingSoftId = null; this.render(); return; }
    store.updateNode(id, { title }, { reason: t('today.viewEditSoftPlan') });
    store.flushVersion(id, { reason: t('today.viewEditSoftPlan') });
    this.editingSoftId = null;
    this.render();
    toast(t('toast.updated'));
  }

  /**
   * 勾选 / 取消勾选软安排：写入节点 done 字段（持久化），不要求填原因。
   * 之前是模块级 Map（doneByDate）刷新即丢 —— 这才是软安排"勾了等于没勾"的根因。
   */
  private toggleSoft(id: string, done: boolean): void {
    store.updateNode(id, { done });
    this.render();
  }

  /* ---------------- 连线（关系） ---------------- */

  /**
   * 打开「编辑关系」面板：改类型 / 改备注 / 删。
   *
   * 画布、检视面板、详情页都走这一个入口 —— 同一个功能只能有一套行为。
   */
  async openEdgeEditor(edgeId: string): Promise<void> {
    const edge = store.lib.edges.find((e) => e.id === edgeId);
    if (!edge) return;
    const r = await openEdgeEditor({
      lib: this.spaceLib(),
      onUpdate: (id, patch) => {
        store.updateEdge(id, patch);
        this.render();
        toast(t('toast.relationUpdated'));
      },
    }, edge);
    // 面板里点了「删除这条关系」→ 面板先关，再走统一的确认流程。
    // ⚠️ 不能在面板开着的时候弹确认框：确认框和面板共用同一个 #modalCard，
    //    后弹的那个会把前一个冲掉（app.ts 里踩过同样的坑）。
    if (r === 'removed') await this.removeEdgeWithConfirm(edgeId);
    if (this.canvas) this.canvas.invalidate();
  }

  /**
   * 删一条关系（统一入口：确认 → 删 → 提示）。
   *
   * ⚠️ 这里用 app 自己的 confirmBox，**不用 window.confirm**：
   *    原生壳（WKWebView）没有实现 alert 面板，window.confirm 会直接返回
   *    "取消" —— 用户点了删除，什么也没发生，也不报错。
   *    这就是"删除不了"的真凶。
   */
  async removeEdgeWithConfirm(edgeId: string): Promise<void> {
    const e = store.lib.edges.find((v) => v.id === edgeId);
    if (!e) return;
    const from = this.entityName(e.fromId);
    const to = this.entityName(e.toId);
    // 拆成两段 t()：键里不塞 "\n"，免得英文表那边写转义容易写歪。
    const msg = t('confirm.deleteTypedRelation', { type: edgeTypeLabel(e.type) })
      + '\n' + t('version.fromTo', { from, to });
    if (!(await confirmBox(t('action.deleteRelation'), msg, t('action.delete')))) return;
    store.removeEdge(edgeId);
    if (this.selectedEdgeId === edgeId) this.selectedEdgeId = null;
    this.render();
    toast(t('toast.deletedFromTo', { from, to }));
  }

  /** 实体（点 / 主题 / 阶段）的显示名 */
  private entityName(id: string): string {
    const n = store.lib.nodes.find((x) => x.id === id);
    if (n) return n.title;
    const th = store.lib.themes.find((x) => x.id === id);
    if (th) return th.name;
    const st = store.lib.stages.find((x) => x.id === id);
    if (st) return st.name;
    return '?';
  }

  /**
   * 切换"下次连线"的类型。
   *
   * 图例里点、拖线途中改，都走这里 —— 这样"下次连什么"和图例显示的
   * 永远是同一件事，不会出现"我明明选了冲突，出来的是支持"。
   */
  setEdgeType(type: EdgeType): void {
    if (this.edgeType === type) return;
    this.edgeType = type;
    const e = $('#lgEdge');
    if (!e) return;
    const types = EDGE_TYPES.filter((ty) => ty !== 'belong');
    e.querySelectorAll('.lg').forEach((x, i) => x.classList.toggle('on', types[i] === type));
  }

  /** 删除一条软安排（带确认） */
  private async deleteSoft(id: string): Promise<void> {
    const n = store.lib.nodes.find((x) => x.id === id);
    if (!n) return;
    if (!(await confirmBox(t('action.delete'), t('confirm.deleteSoftPlan', { title: n.title }), t('action.delete')))) return;
    store.removeNode(id);
    if (this.editingSoftId === id) this.editingSoftId = null;
    this.render();
    toast(t('toast.deleted'));
  }

  /* ---------------- 搜索 ---------------- */

  private query = '';

  /** 搜索索引增量同步：只发变化的和消失的，全量 addAll 在 1 万节点上是秒级开销 */
  private indexPrint = new Map<string, string>();
  private refreshSearch(): void {
    // ⚠️ 索引是**全库**的，不是当前空间的。
    //   索引带 spaceId、查询时在 Worker 侧按空间过滤 ——
    //   这样切空间**不需要重建索引**（全量重建 1 万节点是秒级开销，
    //   而用户每切一周都要付一次是不能接受的）。
    const lib = store.lib;
    const reasons = new Map<string, string[]>();
    for (const v of lib.versions) {
      const arr = reasons.get(v.nodeId);
      if (arr) arr.push(v.reason); else reasons.set(v.nodeId, [v.reason]);
    }
    const alive = new Set<string>();
    for (const n of lib.nodes) {
      alive.add(n.id);
      const doc = {
        id: n.id, spaceId: n.spaceId, title: n.title, content: n.content, tags: n.tags,
        reasons: reasons.get(n.id) ?? [],
      };
      const fp = JSON.stringify(doc);
      if (this.indexPrint.get(n.id) === fp) continue;
      this.indexPrint.set(n.id, fp);
      this.search.add(doc);
    }
    for (const id of this.indexPrint.keys()) {
      if (!alive.has(id)) { this.indexPrint.delete(id); this.search.remove(id); }
    }
  }

  /** 索引整体重建（导入 / 解锁后首次） */
  private resetSearchIndex(): void {
    this.indexPrint.clear();
    this.search.clear();
    this.refreshSearch();
  }

  private async runSearch(q: string): Promise<void> {
    this.query = q;
    if (!q.trim()) {
      this.hits.clear(); this.ctxSet.clear();
      $('#qcnt').textContent = '';
      this.canvas.invalidate();
      this.updateStates();
      emit('searchChanged', { q: '', count: 0, ms: 0 });
      return;
    }
    const t0 = performance.now();
    const res = await this.search.query(q, 200, store.currentSpaceId);
    // 命中必须落在筛选透镜内，否则会高亮一个看不见的点
    const ids = res.map((r) => r.id).filter((id) => {
      const n = store.lib.nodes.find((v) => v.id === id);
      return n ? passesFilter(n, this.filter) && (!this.nodeTypes.size || this.nodeTypes.has(n.type)) : false;
    });
    this.hits = new Set(ids);
    this.ctxSet = this.settings.searchContext ? expandOneHop(this.spaceLib(), ids) : new Set(ids);
    const dt = performance.now() - t0;
    $('#qcnt').textContent = `${ids.length}${isFilterActive(this.filter) ? '/' + this.lens().length : ''}·${dt.toFixed(0)}ms`;
    emit('searchChanged', { q, count: ids.length, ms: Math.round(dt) });
    this.canvas.invalidate();
    this.updateStates();
    if (ids.length && this.settings.searchContext) {
      toast(t('search.hitsWithContext', { n: ids.length, m: this.ctxSet.size - ids.length }));
    }
  }

  /* ---------------- 操作 ---------------- */

  private async createNodeAt(x: number, y: number, prefill = ''): Promise<void> {
    // 周画布里的一切都是"这一周的复盘产出" ⇒ 默认 reflect + #周复盘。
    // 主画布不变（默认 idea）—— 周画布是另一个场所，规则不该一样。
    const inWeek = isWeekSpace(store.currentSpaceId);
    // 类型放在**对象**里而不是 let 变量：类型是在弹窗的按钮回调里改的，
    // 用 let 的话 TS 的控制流分析会把它一直窄化成初始那两个值，
    // 后面判断 `type === 'work'` 就被当成"不可能"了。
    const pick: { type: NodeType } = { type: inWeek ? 'reflect' : 'idea' };
    let title = '';
    const r = await modal({
      title: inWeek ? t('today.writeReview') : t('action.noteSomething'),
      okText: t('action.writeItDown'),
      body: (card) => {
        card.append(el('label', {}, t('field.type')));
        const row = el('div', { class: 'opt-row' });
        for (const ty of NODE_TYPES) {
          const b = el('button', { class: 'opt' + (ty === pick.type ? ' on' : '') }, nodeTypeLabel(ty));
          b.onclick = () => { pick.type = ty; row.querySelectorAll('.opt').forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
          row.append(b);
        }
        card.append(row);
        card.append(el('label', {}, t('onboard.oneSentence')));
        const inp = el('input', { placeholder: t('empty.whatToNote') }) as HTMLInputElement;
        inp.value = prefill;
        inp.oninput = () => { title = inp.value; };
        card.append(inp);
        setTimeout(() => inp.focus(), 20);
      },
      onOk: (card) => {
        title = (card.querySelector('input') as HTMLInputElement)?.value.trim() ?? '';
        if (!title) { toast(t('empty.writeSomething')); return false; }
        return true;
      },
    });
    if (r === null || !title) return;
    // 把当前主题 / 阶段焦点显式写进新节点（避免只靠时基/隐式归属而"看不见"）
    const themeIds = this.themeId ? [this.themeId] : [];
    const stageIds = this.stageId ? [this.stageId] : [];
    // 周画布：打个 #周复盘 标记（周历上就能看出"这周复盘过了"）
    const tags = inWeek ? [WEEK_REVIEW_TAG] : [];
    // 「作品」节点默认给一张卡的大小 —— 它多半要贴图（图卡就是图片铺满整块）。
    const isWork = pick.type === 'work';
    const n = store.addNode({
      type: pick.type, title, x, y, themeIds, stageIds, tags,
      spaceId: store.currentSpaceId,
      w: isWork ? 320 : 240, h: isWork ? 220 : 78,
    });
    this.selected = new Set([n.id]);
    this.render();
    // 周画布：把镜头挪到新点上 —— 引入的原数据横排了整整一周，
    // 新记的那条可能落在屏幕外，用户会以为"没记上"。
    if (inWeek && this.canvas) this.canvas.centerOn(n.id);
    toast(inWeek ? t('toast.weekNoted') : t('toast.recorded'));
  }

  private async deleteNode(id: string): Promise<void> {
    const n = store.lib.nodes.find((x) => x.id === id);
    if (!n) return;
    if (!(await confirmBox(t('action.delete'), t('confirm.deleteNode', { title: n.title }), t('action.delete')))) return;
    store.removeNode(id);
    this.selected.clear();
    toast(t('toast.deleted'));
  }

  /* ---------------- 顶栏 ---------------- */

  private bindHeader(): void {
    $('#seg')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b) this.switchView((b.dataset.v as View));
    });
    $('#q')!.addEventListener('input', (e) => void this.runSearch((e.target as HTMLInputElement).value));
    $('#ctxT')!.addEventListener('click', () => {
      this.settings.searchContext = !this.settings.searchContext;
      ($('#ctxT') as HTMLElement).classList.toggle('on', this.settings.searchContext);
      void saveSettings(this.settings);
      if (this.query) void this.runSearch(this.query);
    });
    ($('#ctxT') as HTMLElement).classList.toggle('on', this.settings.searchContext);

    $('#btnFocus')!.addEventListener('click', () => {
      if (!this.hits.size) return toast(t('onboard.stepSearch'));
      this.switchView('canvas');
      const ids = [...(this.ctxSet.size ? this.ctxSet : this.hits)];
      this.canvas.fit(ids, 1.15);
    });
    $('#btnNew')!.addEventListener('click', () => {
      this.switchView('canvas');
      const r = ($('#cv') as HTMLCanvasElement).getBoundingClientRect();
      const [wx, wy] = [r.width / 2 / this.canvas.viewport.scale, r.height / 2 / this.canvas.viewport.scale];
      void this.createNodeAt(Math.round(wx - this.canvas.viewport.tx / this.canvas.viewport.scale), Math.round(wy - this.canvas.viewport.ty / this.canvas.viewport.scale));
    });
    $('#btnExport')!.addEventListener('click', () => void this.exportMenu());
    $('#btnImport')!.addEventListener('click', () => void this.importFlow());
    $('#btnFilter')!.addEventListener('click', () => this.filterMenu());
    $('#btnKeys')!.addEventListener('click', () => this.showKeys());
    $('#btnSettings')!.addEventListener('click', () => void this.settingsMenu());
    const btnAddTheme = $('#btnAddTheme');
    if (btnAddTheme) btnAddTheme.addEventListener('click', () => void this.addTheme());
    const btnAddStage = $('#btnAddStage');
    if (btnAddStage) btnAddStage.addEventListener('click', () => void this.addStage());
    // 空间指示条上的「回到主画布」
    const btnSpaceBack = $('#spaceBack');
    if (btnSpaceBack) btnSpaceBack.addEventListener('click', () => this.backToMain());
    // 周画布工具条：记一条复盘 / 引入本周原数据 / 周历
    const btnWkReview = $('#wkReview');
    if (btnWkReview) {
      btnWkReview.addEventListener('click', () => {
        this.switchView('canvas');
        // 落点用 nextFreePos（不重叠）—— 引入的原数据横排了一整周，
        // 摆在屏幕中心很容易压在其他点上。
        const pos = this.nextFreePos();
        void this.createNodeAt(pos.x, pos.y);
      });
    }
    const btnWkImport = $('#wkImport');
    if (btnWkImport) btnWkImport.addEventListener('click', () => void this.importWeekData());
    const btnWkCard = $('#wkCard');
    if (btnWkCard) btnWkCard.addEventListener('click', () => void this.openReviewCard());
    const btnSpaceCal = $('#spaceCal');
    if (btnSpaceCal) btnSpaceCal.addEventListener('click', () => this.switchView('wk'));
    // 空间切换器：点开下拉
    const btnSpaceSwitch = $('#spaceSwitch');
    if (btnSpaceSwitch) {
      btnSpaceSwitch.addEventListener('click', (e) => {
        e.stopPropagation();          // 别让"点别处收起"紧接着把它关掉
        this.toggleSpaceMenu();
      });
    }
    // 点别处收起空间菜单
    document.addEventListener('click', () => this.closeSpaceMenu());

    ($('#cv') as HTMLCanvasElement).addEventListener('mousedown', () => ($('#cv') as HTMLCanvasElement).focus());
    $('#zIn')!.addEventListener('click', () => this.canvas.zoom(1.2));
    $('#zOut')!.addEventListener('click', () => this.canvas.zoom(1 / 1.2));
    $('#zFit')!.addEventListener('click', () => {
      const ns = visibleNodesByFocus(this.spaceLib(), this.canvasFocusTheme(), this.canvasFocusStage());
      // 显式「全览」：把当前焦点内的点全部装进视口
      this.canvas.fit(ns.map((n) => n.id), 0.9);
    });
    $('#zReset')!.addEventListener('click', () => this.resetCanvasView());

    window.addEventListener('mousemove', () => this.resetIdle(), { passive: true });
    window.addEventListener('keydown', () => this.resetIdle());

    this.bindRailToggles();
  }

  /**
   * 窄屏侧栏抽屉。两个开关常驻 DOM，靠 CSS 断点决定何时可见（宽屏是死元素）。
   * 开关写 <html data-left-open / data-right-open>，由 CSS 决定位移。
   */
  private bindRailToggles(): void {
    const tg = $('#tgLeft');
    const tr = $('#tgRight');
    if (!tg || !tr) return;
    const root = document.documentElement;

    tg.onclick = (e) => {
      e.stopPropagation();
      const on = root.toggleAttribute('data-left-open');
      tg.classList.toggle('on', on);
      if (on) { root.removeAttribute('data-right-open'); tr.classList.remove('on'); }
    };
    tr.onclick = (e) => {
      e.stopPropagation();
      const on = root.toggleAttribute('data-right-open');
      tr.classList.toggle('on', on);
      if (on) { root.removeAttribute('data-left-open'); tg.classList.remove('on'); }
    };
    // 点遮罩关闭：CSS 用 html[data-left-open]::after 画了一层 scrim
    root.addEventListener('click', () => {
      root.removeAttribute('data-left-open');
      root.removeAttribute('data-right-open');
      tg.classList.remove('on');
      tr.classList.remove('on');
    });
  }

  private bindShortcuts(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if ($('#onboard')!.hidden === false) return;
      const k = e.key;
      if (k === '/') { e.preventDefault(); ($('#q') as HTMLInputElement).focus(); return; }
      if (k === '?') { e.preventDefault(); this.showKeys(); return; }
      if (k === 'Delete' || k === 'Backspace') {
        const id = [...this.selected][0];
        if (id) { e.preventDefault(); void this.deleteNode(id); }
        return;
      }
      if (k === 'Escape') {
        if (this.view === 'detail' && this.detailStack.length) { this.popDetail(); return; }
        this.selected.clear(); this.render();
        return;
      }
      if (k === '1') { this.switchView('canvas'); return; }
      if (k === '2') { this.switchView('tl'); return; }
      if (k === '3') { this.switchView('lv'); return; }
      if (k === '4') { this.switchView('today'); return; }
      if (k === '5') { this.switchView('wk'); return; }
      // 以下仅在画布视图且画布持有焦点时生效，避免抢普通页面快捷键
      const cv = $('#cv') as HTMLCanvasElement;
      if (document.activeElement !== cv) return;
      if (k === 'ArrowLeft') { e.preventDefault(); this.moveSelection('left'); }
      else if (k === 'ArrowRight') { e.preventDefault(); this.moveSelection('right'); }
      else if (k === 'ArrowUp') { e.preventDefault(); this.moveSelection('up'); }
      else if (k === 'ArrowDown') { e.preventDefault(); this.moveSelection('down'); }
      else if (k === 'n' || k === 'N') {
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        const vp = this.canvas.viewport;
        void this.createNodeAt(Math.round(r.width / 2 - vp.tx / vp.scale), Math.round(r.height / 2 - vp.ty / vp.scale));
      }
      else if (k === 'f' || k === 'F') {
        e.preventDefault();
        const ns = visibleNodesByFocus(this.spaceLib(), this.canvasFocusTheme(), this.canvasFocusStage());
        // 有焦点 → 定位到那一面（放大一点看得清）；无焦点 → 全览
        const focused = !!(this.themeId || this.stageId);
        this.canvas.fit(ns.map((n) => n.id), focused ? 1.15 : 0.9);
      }
      else if (k === 'r' || k === 'R') {
        // 重置画布：清焦点 / 筛选 / 搜索 / 选中，回到全局视角（数据不动）
        e.preventDefault();
        this.resetCanvasView();
      }
      else if (k === '+' || k === '=') { e.preventDefault(); this.canvas.zoom(1.2); }
      else if (k === '-') { e.preventDefault(); this.canvas.zoom(1 / 1.2); }
    });
  }

  /**
   * 改主题的父主题。环检测：newParent 不能等于自身，也不能是自身的后代（即
   * 不能再把主题塞到自己的子孙下）。
   * newParent === null 表示提升到顶级。
   */
  private reparentTheme(draggedId: string, newParent: string | null): void {
    if (draggedId === newParent) return;
    if (newParent) {
      // draggedId → 根 的链里如果出现 newParent，说明 newParent 是 draggedId 的祖先，
      // 把 draggedId 放到 newParent 下会成环。
      const up = themeChain(store.lib, draggedId).map((x) => x.id);
      if (up.includes(newParent)) {
        toast(t('error.cannotNestUnderAncestor'));
        return;
      }
    }
    const th = store.lib.themes.find((x) => x.id === draggedId);
    if (!th) return;
    if (th.parentId === newParent) return;
    store.updateTheme(draggedId, { parentId: newParent });
    this.render();
  }

  /**
   * 右键菜单：在此下新建子主题 / 提升到顶级 / 改名 / 删除。
   * 用浮动 div 临时挂到 body，点击其他位置或 Esc 自动消失。
   */
  private showThemeMenu(ev: MouseEvent, th: LifeTheme, deleteBtn: HTMLElement): void {
    closeThemeMenu();
    const menu = el('div', { class: 'ctx-menu' });
    const items: Array<{ label: string; on: () => void; danger?: boolean }> = [
      { label: t('theme.newSubThemeHere'), on: () => void this.addTheme(th.id) },
    ];
    if (th.parentId) items.push({ label: t('field.moveToTopLevel'), on: () => this.reparentTheme(th.id, null) });
    items.push({ label: t('field.changeParentThemeEllipsis'), on: () => void this.reparentViaDialog(th.id) });
    items.push({ label: t('field.renameRecolor'), on: () => void this.renameTheme(th.id) });
    items.push({ label: t('action.delete'), danger: true, on: () => { void deleteBtn.click(); } });
    for (const it of items) {
      const b = el('button', { class: 'ctx-item' + (it.danger ? ' danger' : '') }, it.label);
      b.onclick = (e) => { e.stopPropagation(); closeThemeMenu(); it.on(); };
      menu.append(b);
    }
    menu.style.left = `${ev.clientX}px`;
    menu.style.top = `${ev.clientY}px`;
    document.body.append(menu);
    (window as unknown as { __ctxMenu?: HTMLElement }).__ctxMenu = menu;
    setTimeout(() => document.addEventListener('click', closeThemeMenu, { once: true }), 0);
    document.addEventListener('keydown', escCloseMenu);
  }

  private async reparentViaDialog(id: string): Promise<void> {
    const lib = this.spaceLib();
    const cur = lib.themes.find((x) => x.id === id);
    if (!cur) return;
    let picked: string | null = null;
    await modal({
      title: t('field.changeParentTheme'), okText: t('action.ok'),
      body: (card) => {
        card.append(el('label', {}, t('field.newParentTheme')));
        const sel = el('select') as HTMLSelectElement;
        const o0 = el('option', {}, t('common.noneTopLevel')) as HTMLOptionElement; o0.value = ''; sel.append(o0);
        for (const th of lib.themes) {
          if (th.id === id) continue; // 不能选自己
          const up = themeChain(lib, id).map((x) => x.id);
          if (up.includes(th.id)) continue; // 不能选自己的祖先（会成环）
          const o = el('option', {}, th.name) as HTMLOptionElement; o.value = th.id; sel.append(o);
        }
        sel.value = cur.parentId ?? '';
        sel.onchange = () => { picked = sel.value || null; };
        card.append(sel);
        picked = cur.parentId ?? null;
      },
      onOk: () => true,
    });
    this.reparentTheme(id, picked);
  }

  private async renameTheme(id: string): Promise<void> {
    const cur = store.lib.themes.find((x) => x.id === id);
    if (!cur) return;
    let name = cur.name, color = cur.color;
    await modal({
      title: t('field.changeTheme'), okText: t('action.save'),
      body: (card) => {
        card.append(el('label', {}, t('field.name')));
        const i = el('input', { value: name }) as HTMLInputElement;
        i.oninput = () => { name = i.value; };
        card.append(i);
        card.append(el('label', {}, t('field.color')));
        const cp = el('input', { type: 'color', value: color }) as HTMLInputElement;
        cp.oninput = () => { color = cp.value; };
        card.append(cp);
      },
      onOk: () => {
        if (!name.trim()) { toast(t('error.nameRequired')); return false; }
        return true;
      },
    });
    store.updateTheme(id, { name: name.trim(), color });
    this.render();
    toast(t('toast.updated'));
  }

  private async addTheme(lockParent: string | null = null): Promise<void> {
    let name = '';
    let parentId: string | null = lockParent;
    await modal({
      title: lockParent
        ? t('theme.newSubThemeUnder', { name: store.lib.themes.find((x) => x.id === lockParent)?.name ?? '?' })
        : t('theme.create'),
      okText: t('action.create'),
      body: (card) => {
        card.append(el('label', {}, t('field.name')));
        const i = el('input', { placeholder: t('field.exampleTheme') }) as HTMLInputElement;
        i.oninput = () => { name = i.value; };
        card.append(i);
        if (lockParent) {
          // 锁定父主题时也显示一下，让用户知道会落在哪儿
          const hint = el('div', { style: 'font-size:11.5px;color:var(--dim);margin-top:4px' },
            t('theme.willBeSubThemeOf', { name: store.lib.themes.find((x) => x.id === lockParent)?.name ?? '?' }));
          card.append(hint);
          return;
        }
        // 父主题选择（可空 = 顶级）
        const lib = this.spaceLib();
        const themes = lib.themes;
        if (themes.length) {
          card.append(el('label', {}, t('field.parentTheme')));
          const sel = el('select') as HTMLSelectElement;
          const o0 = el('option', {}, t('common.noneDash')) as HTMLOptionElement;
          o0.value = ''; sel.append(o0);
          for (const th of themes) {
            const o = el('option', {}, th.name) as HTMLOptionElement; o.value = th.id; sel.append(o);
          }
          sel.onchange = () => { parentId = sel.value || null; };
          card.append(sel);
        }
      },
      onOk: (card) => {
        name = (card.querySelector('input') as HTMLInputElement)?.value.trim() ?? '';
        if (!name) { toast(t('theme.namePlaceholder')); return false; }
        return true;
      },
    });
    if (!name) return;
    const th = store.addTheme({ name, parentId, color: '#7f9bd4' });
    this.setFocus(th.id, this.stageId);
    toast(lockParent ? t('toast.subThemeCreated') : t('theme.created'));
  }

  /**
   * 贴图入口（选文件 → 缩放 → 入库）。
   *
   * ⚠️ 原生模式**不走** `<input type=file>`：
   *   ① 原生侧的面板写死了只收 JSON（WKOpenPanelParameters 没有类型字段，
   *      web 的 accept="image/*" 传不过去）—— 桌面端根本选不了图；
   *   ② 那条路实测约 1/10 概率 `input.files` 是空的（见 README 坑 7）。
   *   所以原生自己弹面板、自己读文件、自己缩放，把 dataURL 送回来。
   *
   * 浏览器模式没有原生，仍然用 `<input type=file>`（`isNative()` 分流）。
   */
  private pickImage(cb: (data: string, w: number, h: number) => void): void {
    if (isNative()) {
      this.imageResolver = (f) => {
        if (f.cancelled) return;
        if (f.error) { toast(t('error.imageFailed', { msg: f.error })); return; }
        if (!f.dataUrl) { toast(t('error.imageFailedNoImage')); return; }
        cb(f.dataUrl, f.w, f.h);
      };
      emit('openImage', {});
      return;
    }
    // 浏览器模式：选文件 → 缩放压缩（≤800px 长边、≤1MB）
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const r = await loadImageFile(f);
      if (r.error) { toast(t('error.imageFailed', { msg: r.error })); return; }
      cb(r.data, r.w, r.h);
    };
    input.click();
  }

  /**
   * 贴图：把 dataURL 入库。
   * 不要求填修改原因 —— 这是素材，不是"内容修改"。
   * 贴本地图时清掉旧的 imageUrl（互斥）。
   */
  private setNodeImage(id: string, data: string, w: number, h: number): void {
    store.updateNode(id, { imageData: data, imageW: w, imageH: h, imageUrl: undefined });
    this.render();
    toast(t('toast.imageAttached'));
  }

  /** 贴 URL：不下载、零体积，换设备即丢。贴 URL 时清掉旧的 imageData */
  private setNodeImageUrl(id: string, url: string): void {
    store.updateNode(id, { imageUrl: url, imageData: undefined, imageW: undefined, imageH: undefined });
    this.render();
    toast(t('toast.urlAttached'));
  }

  private removeNodeImage(id: string): void {
    store.updateNode(id, { imageData: undefined, imageW: undefined, imageH: undefined, imageUrl: undefined });
    this.render();
    toast(t('toast.imageRemoved'));
  }

  /** 贴 / 改链接。label 可空（空时检视面板里显示 url 本身） */
  private setNodeLink(id: string, url: string, label: string): void {
    store.updateNode(id, { linkUrl: url, linkLabel: label || undefined });
    this.render();
    toast(t('toast.linkAttached'));
  }

  private removeNodeLink(id: string): void {
    store.updateNode(id, { linkUrl: undefined, linkLabel: undefined });
    this.render();
    toast(t('toast.linkRemoved'));
  }

  /**
   * 切换主题归属。轻量操作，不入版本历史（themeIds 不在 SNAPSHOT_FIELDS）。
   * 注：onAddTag 共用这个方法 —— 入参就是 tag 字符串，新加的标签在 chips 里 on=true。
   */
  private toggleTheme(id: string, themeId: string): void {
    const n = store.lib.nodes.find((v) => v.id === id);
    if (!n) return;
    const next = n.themeIds.includes(themeId)
      ? n.themeIds.filter((x) => x !== themeId)
      : [...n.themeIds, themeId];
    store.updateNode(id, { themeIds: next });
    this.render();
  }

  /** 切换阶段归属。轻量，不入版本历史 */
  private toggleStage(id: string, stageId: string): void {
    const n = store.lib.nodes.find((v) => v.id === id);
    if (!n) return;
    const next = n.stageIds.includes(stageId)
      ? n.stageIds.filter((x) => x !== stageId)
      : [...n.stageIds, stageId];
    store.updateNode(id, { stageIds: next });
    this.render();
  }

  /** 切换/添加/移除标签。toggleTag 名字留着，行为是"有则去、无则加" */
  private toggleTag(id: string, tag: string): void {
    const n = store.lib.nodes.find((v) => v.id === id);
    if (!n) return;
    const tg = tag.trim().replace(/^#/, '').toLowerCase();
    if (!tg) return;
    const next = n.tags.includes(tg)
      ? n.tags.filter((x) => x !== tg)
      : [...n.tags, tg];
    // tags 在 SNAPSHOT_FIELDS，会触发版本 — 用静音 reason
    store.updateNode(id, { tags: next }, {
      reason: next.length > n.tags.length ? t('toast.tagAdded', { tag: tg }) : t('toast.tagRemoved', { tag: tg }),
    });
    this.render();
  }

  private async addStage(): Promise<void> {
    let name = '', start = '', end = '';
    await modal({
      title: t('stage.create'), okText: t('action.create'),
      body: (card) => {
        card.append(el('label', {}, t('field.name')));
        const i = el('input', { placeholder: t('field.exampleStage') }) as HTMLInputElement;
        i.oninput = () => { name = i.value; };
        card.append(i);
        card.append(el('label', {}, t('field.startEndHint')));
        const row = el('div', { class: 'opt-row' });
        const sStart = el('input', { placeholder: t('field.startMonth') }) as HTMLInputElement;
        sStart.style.width = '120px';
        sStart.oninput = () => { start = sStart.value; };
        const sEnd = el('input', { placeholder: t('field.endMonth') }) as HTMLInputElement;
        sEnd.style.width = '120px';
        sEnd.oninput = () => { end = sEnd.value; };
        row.append(sStart, el('span', { style: 'margin:0 8px;color:var(--faint)' }, '→'), sEnd);
        card.append(row);
        card.append(el('p', { style: 'font-size:11.5px;color:var(--faint);margin:6px 0 0' },
          t('stage.autoAssignHint')));
      },
      onOk: (card) => {
        name = (card.querySelectorAll('input')[0] as HTMLInputElement)?.value.trim() ?? '';
        if (!name) { toast(t('stage.namePlaceholder')); return false; }
        // 简单格式校验
        const m = /^\d{4}-\d{2}$/;
        if (start && !m.test(start)) { toast(t('field.startFormat')); return false; }
        if (end && !m.test(end)) { toast(t('field.endFormat')); return false; }
        if (start && end && start > end) { toast(t('error.startAfterEnd')); return false; }
        return true;
      },
    });
    if (!name) return;
    const s = store.addStage({ name, start: start || undefined, end: end || undefined, color: '#7f9bd4' });
    this.setFocus(this.themeId, s.id);
    toast(t('stage.created'));
  }

  private async exportMenu(): Promise<void> {
    const lib = this.spaceLib();
    await modal({
      title: t('action.export'), okText: t('action.exportJson'), cancelText: t('action.close'),
      body: (card) => {
        card.append(el('p', { style: 'font-size:12.5px;color:var(--faint);line-height:1.7;margin-bottom:14px' },
          t('export.plaintextWarning')));
        const mk = (label: string, sub: string, fn: () => void) => {
          const b = el('button', { class: 'opt', style: 'display:block;width:100%;text-align:left;padding:10px 12px;margin-bottom:8px' });
          b.innerHTML = `<div style="color:var(--text)">${label}</div><div style="font-size:11px;color:var(--faint);margin-top:2px">${sub}</div>`;
          b.onclick = fn;
          card.append(b);
        };
        mk(t('export.json'), t('export.nodeRelationPanelVersionList'), () => {
          download(`life-canvas-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(toBundle(lib), null, 2));
          toast(t('toast.exportedJson'));
        });
        mk(t('export.markdown'), t('export.markdownShape'), () => {
          download(`life-canvas-${new Date().toISOString().slice(0, 10)}.md`, toMarkdown(lib, this.areaId), 'text/markdown');
          toast(t('toast.exportedMarkdown'));
        });
        mk(t('export.jsonCanvas'), t('export.opensInObsidian'), () => {
          download(`life-canvas-canvas-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(toJsonCanvas(lib, this.areaId), null, 2));
          toast(t('toast.exportedJsonCanvas'));
        });
        // ⚠️ 「导入 JSON」不再塞在这个菜单里 —— 菜单叫「导出」、
        //    里面放一项「导入」，找的人想不到（实测真有人因此以为功能没了）。
        //    它现在是顶栏独立的按钮 + 设置面板里的入口 + 原生「文件」菜单项。
      },
    });
  }

  /**
   * 导入：原生模式让**原生**弹面板、读文件、把内容送回来；
   * 浏览器模式用 <input type=file>。
   *
   * 为什么不统一用 <input type=file>：那条路靠 WebKit 把文件交给 web 进程，
   * 实测会偶发交不到（原生面板选好了、文件也在，web 那边 input.files 是空的），
   * onchange 拿不到文件 → 导入静默没反应。
   * 原生自己读再把内容送过来，就没有这个环节了。
   */
  private async importFlow(): Promise<void> {
    if (isNative()) {
      const got = await new Promise<{ name: string; text: string; error?: string; cancelled?: boolean } | null>(
        (resolve) => {
          this.importResolver = resolve;
          emit('openImport');
          // 用户可能一直不选。留个兜底，别让 resolver 永远挂着。
          setTimeout(() => {
            if (this.importResolver === resolve) { this.importResolver = null; resolve(null); }
          }, 300000);
        },
      );
      if (!got) return;                       // 超时/没等到
      if (got.cancelled) return;              // 用户在面板上点了取消
      if (got.error) { toast(t('error.readFailed', { msg: got.error }), 3200); return; }
      await this.applyImported(got.name, got.text);
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) {
        // 走到这里说明 change 触发了但没拿到文件 ——
        // 静默 return 的话，用户看到的就是"点了没反应"。
        // 明确说一声，至少知道要重试。
        toast(t('error.fileUnreadable'), 2600);
        return;
      }
      let text = '';
      try {
        text = await f.text();
      } catch (e) {
        toast(t('error.readFailed', { msg: (e as Error).message }), 3200);
        return;
      }
      await this.applyImported(f.name, text);
    };
    input.click();
  }

  /** 导入的共同后半段：确认 → 覆盖写入 → 刷新界面。 */
  private async applyImported(name: string, text: string): Promise<void> {
    // 选中文件后，才把可能开着的设置面板关掉 ——
    // 确认框和设置面板共用同一个 #modalCard，不关就会被冲掉。
    // 反过来，**选文件之前不能关**：用户点了「选择 JSON 文件…」结果面板没了、
    // 文件选择器又没出现，用户眼前就只剩画布（"怎么又回到画布了"）。
    $('#modal')!.hidden = true;
    if (!(await confirmBox(t('action.import'), t('confirm.importOverwrite', { name }), t('import.overwrite')))) return;
    try {
      const lib = fromBundle(JSON.parse(text));
      await this.repo.replaceAll(lib);
      store.replaceLibrary(lib);
      this.search.clear();
      this.refreshSearch();
      this.resetSearchIndex();
      this.setFocus(null, null);
      toast(t('toast.importComplete'));
    } catch (e) {
      toast(t('error.importFailed', { msg: (e as Error).message }), 3000);
    }
  }

  /**
   * 设置面板 —— 面板本体在 app/settings-menu.ts 里。
   *
   * 这边只提供它要用的读写入口：设置对象、系统外观、加密状态，
   * 以及「重画 / 导入 / 载入示例 / 清空 / 重播引导」这几个流程的入口。
   * 面板自己怎么建 DOM、怎么排版，那边说了算。
   */
  private settingsMenuHost(): SettingsMenuHost {
    return {
      settings: () => this.settings,
      systemTheme: () => this.systemTheme,
      hasSessionKey: () => !!this.sessionKey,
      spaceLib: () => this.spaceLib(),
      render: () => { this.render(); },
      invalidateCanvas: () => { this.canvas?.invalidate(); },
      toggleCrypto: () => this.toggleCrypto(),
      importFlow: () => this.importFlow(),
      loadSample: () => this.loadSample(),
      clearAll: () => this.clearAll(),
      showOnboard: () => { this.showOnboard(); },
      reopen: () => this.settingsMenu(),
    };
  }

  /** 打开设置面板。 */
  private async settingsMenu(): Promise<void> {
    await openSettingsMenu(this.settingsMenuHost());
  }

  private async toggleCrypto(): Promise<void> {
    if (this.sessionKey) {
      if (!(await confirmBox(t('crypto.turnOff'), t('crypto.turnOffExplain'), t('action.close')))) return;
      this.sessionKey = null;
      this.repo.setKey(null);
      await db.meta.put({ key: 'cryptoEnabled', value: false });
      await saveCryptoConfig({ enabled: false, salt: null, iterations: 600_000, verifier: null });
      // 用会话密钥重写一遍，保证落盘格式一致
      await this.repo.replaceAll(store.lib);
      this.resetIdle();
      toast(t('toast.encryptionOff'));
      return;
    }
    let pw = '';
    await modal({
      title: t('crypto.turnOn'), okText: t('onboard.next'),
      body: (card) => {
        card.append(el('p', { style: 'font-size:12.5px;color:var(--dim);line-height:1.7;margin-bottom:12px' },
          t('crypto.setPasswordWarning')));
        card.append(el('label', {}, t('crypto.masterPassword')));
        const i = el('input', { type: 'password' }) as HTMLInputElement;
        i.oninput = () => { pw = i.value; };
        card.append(i);
        setTimeout(() => i.focus(), 20);
      },
      onOk: () => {
        if (pw.length < 6) { toast(t('crypto.minLength')); return false; }
        return true;
      },
    });
    if (!pw) return;
    const { config, key } = await setupPassword(pw);
    await saveCryptoConfig(config);
    await db.meta.put({ key: 'cryptoEnabled', value: true });
    this.sessionKey = key;
    this.repo.setKey(key);
    await this.repo.replaceAll(store.lib);
    this.resetIdle();
    this.render();
    toast(t('toast.encryptionOn'));
  }

  private async clearAll(): Promise<void> {
    if (!(await confirmBox(t('action.clearData'), t('error.deleteAllWarning'), t('action.confirmClear')))) return;
    await this.repo.clear();
    store.replaceLibrary({ nodes: [], edges: [], themes: [], stages: [], milestones: [], versions: [], customStatuses: [] });
    this.search.clear();
    this.setFocus(null, null);
    toast(t('toast.cleared'));
  }

}

/** 主题右键菜单的工具函数 —— 模块级，因为菜单是全局唯一的 */
function closeThemeMenu(): void {
  const m = (window as unknown as { __ctxMenu?: HTMLElement }).__ctxMenu;
  if (m) { m.remove(); (window as unknown as { __ctxMenu?: HTMLElement }).__ctxMenu = undefined; }
  document.removeEventListener('keydown', escCloseMenu);
}
function escCloseMenu(e: KeyboardEvent): void { if (e.key === 'Escape') closeThemeMenu(); }

/** 单例：视图闭包需要引用 App 内部状态 */
const app = new App();

export async function main(): Promise<void> {
  await app.boot();
}
