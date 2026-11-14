//
//  MainWindowController.swift
//  窗口 + 工具栏 + 菜单栏。
//
//  原生接管顶栏，web 那套 header 在 <html data-native-shell> 下由 CSS 让位。
//  这里只重新实现"窗口级"的控件：视图切换、搜索、以及几个动作入口 ——
//  业务逻辑一行都不重复实现，一律通过 Bridge 让 web 去跑。
//

import AppKit
import WebKit
import UniformTypeIdentifiers
import ImageIO

private enum ToolbarID {
    static let viewSeg = NSToolbarItem.Identifier("viewSeg")
    static let search = NSToolbarItem.Identifier("searchField")
    static let count = NSToolbarItem.Identifier("searchCount")
    static let filter = NSToolbarItem.Identifier("filterBtn")
    static let settings = NSToolbarItem.Identifier("settingsBtn")
    static let newItem = NSToolbarItem.Identifier("newItem")
}

final class MainWindowController: NSWindowController, BridgeDelegate, WKUIDelegate, WKDownloadDelegate {
    // bridge / webView 保持 internal：SelfTest 要直接驱动它们
    let bridge = Bridge()
    private let distRoot: URL
    private(set) var webView: WKWebView!

    private let seg = NSSegmentedControl()
    private let search = NSSearchField()
    private let countLabel = NSTextField(labelWithString: "")
    private let filterBtn = NSButton()
    private let settingsBtn = NSButton()
    private let newBtn = NSButton()

    /// 顶栏现在显示的文字（自测用）。
    ///
    /// ★ 为什么需要它：语言切换是**两边各管各的**（web 管界面、原生管顶栏），
    ///   「顶栏中文、界面英文」这种分裂，**只读 web 侧是发现不了的** ——
    ///   必须把原生顶栏的实际文字读出来，跟 web 侧的语言放在一起比。
    var toolbarTexts: [String] {
        var out: [String] = []
        for i in 0..<seg.segmentCount {
            out.append(seg.label(forSegment: i) ?? "")
        }
        out.append(search.placeholderString ?? "")
        out.append(filterBtn.title)
        out.append(settingsBtn.title)
        out.append(newBtn.title)
        return out
    }

    /// Bundle 里的版本号（用户可见版本 + 构建号）。
    ///
    /// ★ 真源就是 Info.plist —— Finder「关于本机」看到的也是这两个值。
    ///   裸二进制（开发期免打包那个 LifeCanvas-dev）没有 Info.plist，
    ///   这里会读到空串；web 那边拿不到就继续用构建期注进去的值。
    static var bundleVersion: (short: String, build: String) {
        let info = Bundle.main.infoDictionary
        let s = (info?["CFBundleShortVersionString"] as? String ?? "")
            .trimmingCharacters(in: .whitespaces)
        let b = (info?["CFBundleVersion"] as? String ?? "")
            .trimmingCharacters(in: .whitespaces)
        return (s, b)
    }

    /// 与 index.html 里 #seg 的顺序一一对应；cmd 是菜单里的 ⌘N
    ///
    /// ⚠️ 新增视图要加在**末尾**：前面几段的下标被自测和截图脚本按位置引用
    ///    （SelfTest 的 selectView(1) 指的是画布）。
    ///    插在中间会把那些下标全部错位。
    private static let views: [(seg: String, titleKey: String, cmd: String)] = [
        ("today", "view.today", "4"),
        ("canvas", "view.canvas", "1"),
        ("tl", "view.timeline", "2"),
        ("lv", "view.list", "3"),
        ("wk", "native.weekCalendar", "5"),
    ]

    private var locked = false
    /// 搜索 / 筛选的当前计数。语言变了要重刷标题，所以留着。
    private var lastQuery = ""
    private var lastCount = 0
    private var lastMs = 0
    private var lastFilterCount = 0

    /// 自测用：收到文件面板请求时记一笔（SelfTest 拿它做断言）
    private(set) var sawOpenPanel = false
    /// 自测用：收到过几次面板请求。用**计数**而不是布尔 ——
    /// 布尔在第二次请求时还是 true，断言"导出也弹了面板"会变成废话。
    private(set) var openPanelCount = 0
    /// 自测用：最后一次面板请求是"选文件"（false）还是"存到哪"（true）
    private(set) var lastOpenPanelWasSave = false
    /// 自测用：导出这条路走通了没有（<a download> → WKDownload）
    private(set) var sawDownload = false
    /// 自测用：下载落盘完成 / 出错
    private(set) var downloadFinished = false
    private(set) var downloadError: String?
    /// 自测用：不为 nil 时保存面板不弹，直接存到这个目录。
    /// 用来证明「<a download> → WKDownload → 真的写出文件」整条链，
    /// 光断言"面板要弹了"证明不了文件真的落盘。
    var autoSaveDirectory: URL?
    /// 自测用：不为 nil 时导入面板不弹，直接读这个文件。
    /// 用来做「导出 → 导回去」的往返测试。
    var autoImportFile: URL?
    /// 自测用：不为 nil 时贴图面板不弹，直接读这个图片文件。
    /// 用来证明「原生选图 → 缩放 → 送回 web → 入库」整条链是通的。
    var autoImageFile: URL?
    /// 自测用：贴图这条路收到过几次请求 / 最后一次送回去的图多大
    private(set) var imagePanelCount = 0
    private(set) var lastImageBytes = 0
    private(set) var lastImageSize: (w: Int, h: Int) = (0, 0)
    /// 自测用：保存面板最终用上的建议文件名（nil = 没等到）
    private(set) var downloadPanelName: String?
    /// 自测用：true 时**不真的弹面板**，直接回 nil。
    /// 真的弹出来会把自测卡住（面板是模态的，等着人点）。
    var suppressOpenPanel = false

    /// 下载文件名。runOpenPanelWith **不携带建议文件名**，
    /// 而 web 侧知道（<a download="life-canvas-2026-10-23.json">），
    /// 所以 web 点下载前先把名字报上来，这里存着给保存面板用。
    private var pendingDownloadName: String?

    init(distRoot: URL) {
        self.distRoot = distRoot
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.title = L10n.windowTitle(false)
        // 720 而不是原先的 980：980 那条线是在断点存在**之前**定的，
        // 理由是"两块固定侧栏会把画布挤没"。现在 ≤980 左栏已经是抽屉，
        // ≤760 右栏也是 —— 那个理由不成立了，锁在 980 等于让第三个断点
        // 在 macOS 上永远走不到，右栏也就永远变不成抽屉。
        win.minSize = NSSize(width: 720, height: 560)
        super.init(window: win)
        // distRoot 必须在 super.init 之前赋值 —— super.init(window:) 内部会碰 windowDidLoad
        win.center()
        // 显式建一次，不赌 AppKit 什么时候回调 windowDidLoad。
        // setUp 有幂等守卫，谁先到都只建一次。
        setUp()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) 未实现") }

    private var didSetUp = false

    override func windowDidLoad() {
        super.windowDidLoad()
        setUp()
    }

    private func setUp() {
        guard !didSetUp else { return }
        didSetUp = true

        buildWebView()
        buildToolbar()
        buildMenu()
        observeAppearance()

        // 语言变了 → 菜单 / 工具栏 / 窗口标题整体重刷。
        // 一次注册就够（只有一个窗口控制器）。
        L10n.onChange = { [weak self] in self?.refreshLocale() }

        bridge.delegate = self
        bridge.attach(to: webView)
        bridge.onReady = { [weak self] in
            self?.sawReady = true
            // 把**系统语言**告诉 web（不是当前显示的那个）。
            //
            // ⚠️ 为什么报 systemLocale 而不是 locale：
            //    locale 是"当前显示什么"，可能是上次用户锁过的偏好；
            //    web 要的是"跟随系统时该显示什么" —— 那是 systemLocale。
            //    报错了的话，web 的「跟随系统」会变成"跟随上次选过的语言"。
            //
            // web 那边有显式偏好（设置面板里锁过）就以它的为准，
            // 没有才采纳这里给的系统语言 —— 见 src/i18n/index.ts。
            self?.bridge.send("locale", ["locale": L10n.systemLocale.rawValue])
            // 把**正在跑的这个包**的版本号告诉 web —— 设置面板里显示的就是它。
            //
            // 为什么原生报、而不是让 web 用构建期的值：
            //   开发期跑的是裸二进制（没 Info.plist），发布版跑的是 bundle 里的包，
            //   同一份源码打出来的两个包版本可能不同 —— 设置里显示的必须是
            //   **正在跑的那个**的版本，而不是源码树里的版本。
            let v = Self.bundleVersion
            self?.bridge.send("appInfo", ["version": v.short, "build": v.build])
        }
        webView.load(URLRequest(url: URL(string: "app://local/index.html")!))
    }

    /// SelfTest 挂载点。生产路径为 nil，不影响运行。
    var selfTest: SelfTest?
    /// web 是否真的发过 ready。SelfTest 拿来当断言 —— 挂在这而不是用来起跑，
    /// 这样"ready 没来"本身也是一条可读的失败，而不是一个死等。
    private(set) var sawReady = false
    private var selfTestTimer: DispatchSourceTimer?

    /// 定时起跑，不等 ready。ready 没到的话，第一条断言会如实报出来。
    func startSelfTest() {
        let t = DispatchSource.makeTimerSource()
        t.schedule(deadline: .now() + 8)
        t.setEventHandler { [weak self] in self?.selfTest?.run() }
        t.resume()
        selfTestTimer = t
    }

    /// 模拟用户在原生 segmented 上点第 i 段（SelfTest 用）
    func selectView(_ i: Int) {
        guard i >= 0, i < Self.views.count else { return }
        seg.selectedSegment = i
        viewChanged(seg)
    }

    /// 按视图名切（today / canvas / tl / lv / wk）。WindowShot 用。
    func selectViewByName(_ name: String) {
        guard let i = Self.views.firstIndex(where: { $0.seg == name }) else { return }
        selectView(i)
    }

    // MARK: - webView

    private func buildWebView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(SchemeHandler(root: distRoot), forURLScheme: "app")
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        webView = WKWebView(frame: .zero, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        // ⚠️ 不设 uiDelegate 的话，<input type="file"> 和 <a download> 都会被
        //    WebKit **静默丢弃** —— 点「选择 JSON 文件…」什么都不会发生，
        //    既不报错也不弹面板（2026-10-23 用户反馈）。
        webView.uiDelegate = self
        window?.contentView = webView
    }

    // MARK: - 工具栏

    private func buildToolbar() {
        guard let window else { return }
        let toolbar = NSToolbar(identifier: "main")
        toolbar.allowsUserCustomization = false
        toolbar.delegate = self
        window.toolbar = toolbar
        window.toolbarStyle = .unified      // 标题与工具栏共用一行
        window.titleVisibility = .hidden    // 标题栏留给工具栏，web 内容从其下方开始

        seg.segmentCount = Self.views.count
        for (i, v) in Self.views.enumerated() {
            seg.setLabel(L10n.t(v.titleKey), forSegment: i)
            seg.setTag(i, forSegment: i)
        }
        seg.selectedSegment = 0          // today，与 web 默认视图一致
        seg.target = self
        seg.action = #selector(viewChanged(_:))

        search.placeholderString = L10n.t("native.searchPlaceholder")
        search.target = self
        search.action = #selector(searchChanged)
        search.sendsWholeSearchString = false
        search.focusRingType = .none
        // 工具栏不会自动给搜索框定宽：不加约束时 AppKit 按"剩余空间"分配，
        // 宽屏下被 flexibleSpace 挤成一条（placeholder 只剩三个字），
        // 同时刷 "ambiguous height or width" 警告。
        // 这里给一个可伸缩区间：平时 240，窗口窄了先让搜索框缩到 160，
        // 而不是把后面的按钮挤出工具栏（最小窗口宽 720）。
        let searchWidth = search.widthAnchor.constraint(equalToConstant: 240)
        searchWidth.priority = .defaultHigh          // 空间不够时这条先让位
        searchWidth.isActive = true
        search.widthAnchor.constraint(greaterThanOrEqualToConstant: 160).isActive = true
        search.widthAnchor.constraint(lessThanOrEqualToConstant: 300).isActive = true
        search.heightAnchor.constraint(equalToConstant: 24).isActive = true

        countLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        countLabel.textColor = .secondaryLabelColor
        // 固定宽度，否则 "3 个 · 12ms" ↔ "128 个 · 210ms" 每次都让工具栏抖一下。
        // 放在这里而不是 itemForItemIdentifier —— 后者可能被调多次，重复加约束会打架。
        countLabel.widthAnchor.constraint(equalToConstant: 96).isActive = true
        countLabel.heightAnchor.constraint(equalToConstant: 16).isActive = true

        filterBtn.title = L10n.t("filter.title")
        filterBtn.bezelStyle = .rounded
        filterBtn.target = self
        filterBtn.action = #selector(filterClicked)

        // ⚠️ 工具栏必须有「设置」这个入口。
        //    原生模式下 web 顶栏被隐藏（--hd 归零），顶栏上的「设置」按钮看不见；
        //    只剩菜单栏一项的话，等于「设置」在窗口里根本不存在。
        settingsBtn.title = L10n.t("action.settings")
        settingsBtn.bezelStyle = .rounded
        settingsBtn.target = self
        settingsBtn.action = #selector(settingsClicked)

        newBtn.title = L10n.t("action.recordButton")
        newBtn.bezelStyle = .rounded
        newBtn.target = self
        newBtn.action = #selector(newClicked)
    }

    @objc private func viewChanged(_ sender: NSSegmentedControl) {
        let i = sender.selectedSegment
        guard i >= 0, i < Self.views.count else { return }
        bridge.send("view", ["view": Self.views[i].seg])
        returnFocusToCanvas()
    }

    @objc private func searchChanged() {
        bridge.send("search", ["q": search.stringValue])
    }

    @objc private func filterClicked() { run("filter"); returnFocusToCanvas() }
    @objc private func settingsClicked() { run("settings") }
    @objc private func newClicked() { run("new"); returnFocusToCanvas() }

    /// 原生控件的点击不会触发 web 里那个把焦点还给 #cv 的 mousedown，
    /// 而画布快捷键有 activeElement === #cv 的守卫 —— 不显式还回去，
    /// 方向键 / n / f / + / - 会静默失效。
    private func returnFocusToCanvas() {
        bridge.send("focusCanvas")
    }

    private func run(_ action: String) {
        bridge.send("action", ["action": action])
    }

    // MARK: - 菜单栏

    /// 需要跟着界面语言走的菜单项。语言一变就按 key 重刷标题。
    private var localizedItems: [(item: NSMenuItem, key: String)] = []
    /// 同上，菜单本身的名字（文件 / 编辑 / 视图…）。
    private var localizedMenus: [(menu: NSMenu, key: String)] = []
    /// 「关系上下文」那一项。留引用是为了按项更新勾选态（见 buildMenu 里的注释）。
    private var ctxMenuItem: NSMenuItem?

    /// 建一个会跟着语言走的菜单。
    private func menu(titleKey: String) -> NSMenu {
        let m = NSMenu(title: L10n.t(titleKey))
        localizedMenus.append((m, titleKey))
        return m
    }

    /// 往菜单里加一项会跟着语言走的条目。
    @discardableResult
    private func addItem(_ menu: NSMenu, key: String, action: Selector?,
                         keyEquivalent: String = "") -> NSMenuItem {
        let it = menu.addItem(withTitle: L10n.t(key), action: action, keyEquivalent: keyEquivalent)
        localizedItems.append((it, key))
        return it
    }

    /// 语言变了：把所有可本地化的标题重刷一遍。
    ///
    /// ⚠️ 菜单项标题改了之后，AppKit 不会自动重排 —— 但 NSMenuItem.title
    ///    一改，菜单下次打开时就是新的，所以这里只需要赋值。
    private func refreshLocale() {
        for (m, key) in localizedMenus { m.title = L10n.t(key) }
        for (it, key) in localizedItems { it.title = L10n.t(key) }
        for (i, v) in Self.views.enumerated() {
            seg.setLabel(L10n.t(v.titleKey), forSegment: i)
        }
        search.placeholderString = L10n.t("native.searchPlaceholder")
        filterBtn.title = L10n.filterTitle(lastFilterCount)
        settingsBtn.title = L10n.t("action.settings")
        newBtn.title = L10n.t("action.recordButton")
        updateCountLabel()
        window?.title = L10n.windowTitle(locked)
        for (id, item) in toolbarItems {
            item.paletteLabel = L10n.t(toolbarPaletteKeys[id] ?? "")
        }
    }

    /// 工具栏项 → 无障碍名字。放在一处，refreshLocale 才刷得全。
    private let toolbarPaletteKeys: [NSToolbarItem.Identifier: String] = [
        ToolbarID.viewSeg: "native.menuView",
        ToolbarID.search: "action.search",
        ToolbarID.count: "native.results",
        ToolbarID.filter: "filter.title",
        ToolbarID.settings: "action.settings",
        ToolbarID.newItem: "native.record",
    ]
    /// 建出来的工具栏项。存一份，语言变了才刷得到 paletteLabel。
    private var toolbarItems: [NSToolbarItem.Identifier: NSToolbarItem] = [:]

    private func buildMenu() {
        let mainMenu = NSMenu()

        // ── 应用 ──
        let appMenu = menu(titleKey: "app.name")
        addItem(appMenu, key: "native.aboutApp",
                action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
        appMenu.addItem(.separator())
        addItem(appMenu, key: "native.settingsEllipsis", action: #selector(menuSettings), keyEquivalent: ",")
        appMenu.addItem(.separator())
        addItem(appMenu, key: "native.hideApp", action: #selector(NSApplication.hide(_:)),
                keyEquivalent: "h")
        appMenu.addItem(.separator())
        addItem(appMenu, key: "native.quitApp", action: #selector(NSApplication.terminate(_:)),
                keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = appMenu
        mainMenu.addItem(appItem)

        // ── 文件 ──
        let fileMenu = menu(titleKey: "native.menuFile")
        addItem(fileMenu, key: "native.newRecord", action: #selector(menuNew), keyEquivalent: "n")
        fileMenu.addItem(.separator())
        addItem(fileMenu, key: "native.importJsonEllipsis", action: #selector(menuImport), keyEquivalent: "i")
        addItem(fileMenu, key: "native.exportEllipsis", action: #selector(menuExport), keyEquivalent: "e")
        let fileItem = NSMenuItem(); fileItem.submenu = fileMenu
        mainMenu.addItem(fileItem)

        // ── 编辑 ──
        // target 必须走 first responder（这里保持 selector 不绑本地方法），
        // 否则 WKWebView 里的复制粘贴 / 撤销全部失效。
        let editMenu = menu(titleKey: "native.menuEdit")
        addItem(editMenu, key: "native.undo", action: Selector(("undo:")), keyEquivalent: "z")
        addItem(editMenu, key: "native.redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        addItem(editMenu, key: "native.cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        addItem(editMenu, key: "native.copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        addItem(editMenu, key: "native.paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        addItem(editMenu, key: "native.selectAll", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem(); editItem.submenu = editMenu
        mainMenu.addItem(editItem)

        // ── 视图 ──
        // 注意：菜单项的 keyEquivalent 一定要带修饰键。裸 "f" 会把普通字母键
        // 全局吃掉，web 画布的 f 快捷键和输入框打字都会失效。
        let viewMenu = menu(titleKey: "native.menuView")
        for (i, v) in Self.views.enumerated() {
            let it = addItem(viewMenu, key: v.titleKey,
                             action: #selector(menuSwitchView(_:)),
                             keyEquivalent: v.cmd)
            it.tag = i
        }
        viewMenu.addItem(.separator())
        addItem(viewMenu, key: "native.focusSearchResults",
                action: #selector(menuFocus), keyEquivalent: "f")
        viewMenu.items.last?.keyEquivalentModifierMask = [.command, .shift]
        addItem(viewMenu, key: "action.resetCanvas",
                action: #selector(menuReset), keyEquivalent: "r")
        viewMenu.items.last?.keyEquivalentModifierMask = [.command, .shift]
        viewMenu.addItem(.separator())
        addItem(viewMenu, key: "native.fullScreen",
                action: #selector(toggleFullScreen), keyEquivalent: "f")
        viewMenu.items.last?.keyEquivalentModifierMask = [.control, .command]
        let viewItem = NSMenuItem(); viewItem.submenu = viewMenu
        mainMenu.addItem(viewItem)

        // ── 搜索 ──
        let searchMenu = menu(titleKey: "action.search")
        addItem(searchMenu, key: "native.focusSearchField",
                action: #selector(menuFocusSearch), keyEquivalent: "f")
        searchMenu.addItem(.separator())
        let ctxItem = addItem(searchMenu, key: "search.relationContext",
                              action: #selector(menuToggleContext))
        ctxItem.target = self
        ctxItem.state = .on
        // ⚠️ 留一份引用：勾选态要跟着 web 走。以前是按**标题**在菜单里搜
        //    （first { $0.title == "search.relationContext" }）—— 一旦界面切成英文，
        //    那条搜索就再也匹配不上了，勾选态会悄悄失灵。
        ctxMenuItem = ctxItem
        let searchItem = NSMenuItem(); searchItem.submenu = searchMenu
        mainMenu.addItem(searchItem)

        // ── 窗口 ──
        let windowMenu = menu(titleKey: "native.menuWindow")
        addItem(windowMenu, key: "native.minimize",
                action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        addItem(windowMenu, key: "native.zoom",
                action: #selector(NSWindow.performZoom(_:)))
        windowMenu.addItem(.separator())
        addItem(windowMenu, key: "native.bringAllToFront",
                action: #selector(NSApplication.arrangeInFront(_:)))
        let windowItem = NSMenuItem(); windowItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu
        mainMenu.addItem(windowItem)

        // ── 帮助 ──
        // 不给快捷键面板设 keyEquivalent：留空让 web 自己的 "?" 处理，
        // 给了反而会被菜单先吃掉。
        let helpMenu = menu(titleKey: "native.help")
        addItem(helpMenu, key: "help.shortcuts", action: #selector(menuKeys))
        let helpItem = NSMenuItem(); helpItem.submenu = helpMenu
        NSApp.helpMenu = helpMenu
        mainMenu.addItem(helpItem)

        NSApp.mainMenu = mainMenu
    }

    @objc private func menuNew() { run("new"); returnFocusToCanvas() }
    @objc private func menuExport() { run("export") }
    @objc private func menuSettings() { run("settings") }
    @objc private func menuImport() { run("import") }
    @objc private func menuFocus() { run("focus"); returnFocusToCanvas() }
    /// 重置画布：清焦点 / 筛选 / 搜索 / 选中，回到全局视角（数据不动）。
    /// 走 web 侧同一个动作 —— 原生不重复实现业务，只做转发。
    @objc private func menuReset() { run("reset"); returnFocusToCanvas() }
    @objc private func menuKeys() { run("keys") }
    @objc private func menuFocusSearch() { window?.makeFirstResponder(search) }
    @objc private func menuToggleContext() { run("toggleContext") }

    @objc private func menuSwitchView(_ sender: NSMenuItem) {
        guard sender.tag >= 0, sender.tag < Self.views.count else { return }
        seg.selectedSegment = sender.tag
        bridge.send("view", ["view": Self.views[sender.tag].seg])
        returnFocusToCanvas()
    }

    @objc private func toggleFullScreen() { window?.toggleFullScreen(nil) }

    // MARK: - 外观

    private var appearanceObs: NSKeyValueObservation?

    /// web 端选的是「跟随系统」时，外观由系统说了算，变化要推给 web。
    /// 用户在设置里显式选了暗色/亮色，就把窗口外观钉死，不再推 ——
    /// 否则系统一变，用户刚选的主题就被改回去了。
    private var followSystemAppearance = true

    private func observeAppearance() {
        appearanceObs = window?.observe(\.effectiveAppearance) { [weak self] _, _ in
            self?.pushTheme()
        }
        // KVO 只在**变化**时回调。启动时系统已经是浅色的话，一次都不会触发 ——
        // web 会一直停在默认的深色，于是「工具栏浅色、内容深色」。
        // 所以这里必须先推一次当前值。
        pushTheme()
    }

    /// 把窗口当前的实际外观推给 web。只在「跟随系统」时推。
    private func pushTheme() {
        guard followSystemAppearance, let w = window else { return }
        let dark = w.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        bridge.send("theme", ["theme": dark ? "dark" : "light"])
    }

    /// 搜索结果数。语言变了要重刷，所以单独拎出来。
    private func updateCountLabel() {
        countLabel.stringValue = lastQuery.isEmpty ? "" : L10n.countText(lastCount, lastMs)
    }

    // MARK: - BridgeDelegate

    // MARK: - 下载（<a download> → WKDownload）
    //
    // ⚠️ 这一段是「导出」能不能用的关键，而且是**静默失败**：
    // WebKit 看到 <a download> 会把这次导航标成 shouldPerformDownload=true，
    // 这时候必须回 .download。回 .allow 的话 WebKit 会**真的去导航那个 blob: URL**，
    // 结果是：不弹面板、不落盘、不报错 —— 点了跟没点一样。
    //
    // .download 之后 WebKit 走 WKDownload：
    //   didBecome（把 delegate 装上）→ decideDestinationUsing（这里弹保存面板）。
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    /// 服务器说"这个我给不了，你存吧"（Content-Disposition / 不认识的 MIME）时的兜底。
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView,
                 navigationAction: WKNavigationAction,
                 didBecome download: WKDownload) {
        sawDownload = true
        download.delegate = self
    }

    /// 存到哪：弹保存面板，把用户选的位置交回 WebKit（文件由它写）。
    func download(_ download: WKDownload,
                  decideDestinationUsing response: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let window = self.window else { completionHandler(nil); return }
            // 建议文件名：blob: 的 suggestedFilename 不可靠（实测是 "Unknown"），
            // 用 web 另发消息报上来的名字 —— 那才是真正的文件名。
            self.awaitDownloadName { name in
                let finalName = name ?? (suggestedFilename.isEmpty ? L10n.t("common.untitled") : suggestedFilename)
                self.downloadPanelName = finalName
                // 自测模式：直接存到指定目录，跳过保存面板。
                if let dir = self.autoSaveDirectory {
                    completionHandler(dir.appendingPathComponent(finalName))
                    return
                }
                guard !self.suppressOpenPanel else { completionHandler(nil); return }
                self.presentSavePanel(name: finalName, window: window) { url in
                    completionHandler(url)
                }
            }
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        downloadFinished = true
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadError = error.localizedDescription
    }

    // MARK: - 文件选择 / 保存面板
    //
    // WKWebView 里的两件事都要靠这个回调才能落地：
    //   · <input type="file">  → 选文件（导入 JSON）
    //   · <a download href="blob:…"> → 存文件（导出 JSON / Markdown，走上面的 WKDownload）
    //
    // 不实现的话，WebKit 会**静默丢弃**请求：点了没反应，不报错。
    //
    // ⚠️ 面板必须推到下一个 runloop 再开：runOpenPanelWith 是在 WebKit 的
    //    内部状态机里回调的，同步开面板会让 WebKit 认为这次交互还没结束。
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let window = self.window else { completionHandler(nil); return }
            self.sawOpenPanel = true
            self.openPanelCount += 1

            // allowsDirectories = true → 这是「存到哪」（下载）；
            // false → 这是「选哪个」（上传）。
            let isSave = parameters.allowsDirectories
            self.lastOpenPanelWasSave = isSave

            if isSave {
                // 理论上走不到（下载已经在 decidePolicyFor 里转成 WKDownload 了），
                // 留着当兜底：万一 WebKit 换了策略，这里还能弹个保存面板。
                self.presentSavePanel(name: self.pendingDownloadName, window: window) { url in
                    completionHandler(url.map { [$0] })
                }
            } else {
                // 原生模式下 web 不走 <input type=file>（见 presentImportPanel），
                // 这里只是兜底：万一哪天 web 又用了文件输入，别静默丢弃。
                guard !self.suppressOpenPanel else { completionHandler(nil); return }
                let panel = NSOpenPanel()
                panel.allowsMultipleSelection = parameters.allowsMultipleSelection
                panel.canChooseDirectories = false
                panel.canChooseFiles = true
                // 导入只收 JSON。其他类型不展示，免得选了之后前端才报错。
                panel.allowedContentTypes = [.json]
                panel.beginSheetModal(for: window) { resp in
                    completionHandler(resp == .OK ? panel.urls : nil)
                }
            }
        }
    }

    // MARK: - JS 对话框（alert / confirm / prompt）
    //
    // ⚠️ **不实现的后果是静默失败**，而且症状极像"功能坏了"：
    //    WKWebView 找不到对应的 WKUIDelegate 方法时，会把
    //    window.confirm() 当成"用户点了取消"直接返回 false，
    //    window.alert() 则什么都不弹。
    //    → 网页里的「删除」按钮点了没反应，**不报错、不弹框**。
    //    这就是原生壳里"关系删不掉"的真凶（浏览器里同一条代码是好的，
    //    所以只看网页代码永远看不出来）。
    //
    // 面板必须推到下一个 runloop 再开（和上面的文件面板同一个理由）。
    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let window = self.window else { completionHandler(); return }
            let alert = NSAlert()
            alert.messageText = L10n.t("native.notice")
            alert.informativeText = message
            alert.addButton(withTitle: L10n.t("native.ok"))
            alert.beginSheetModal(for: window) { _ in completionHandler() }
        }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let window = self.window else { completionHandler(false); return }
            let alert = NSAlert()
            alert.messageText = L10n.t("native.confirm")
            alert.informativeText = message
            alert.addButton(withTitle: L10n.t("action.ok"))
            alert.addButton(withTitle: L10n.t("action.cancel"))
            alert.beginSheetModal(for: window) { resp in
                completionHandler(resp == .alertFirstButtonReturn)
            }
        }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let window = self.window else { completionHandler(nil); return }
            let alert = NSAlert()
            alert.messageText = L10n.t("native.input")
            alert.informativeText = prompt
            let field = NSTextField(string: defaultText ?? "")
            alert.accessoryView = field
            alert.addButton(withTitle: L10n.t("action.ok"))
            alert.addButton(withTitle: L10n.t("action.cancel"))
            alert.beginSheetModal(for: window) { resp in
                completionHandler(resp == .alertFirstButtonReturn ? field.stringValue : nil)
            }
        }
    }

    /// 打开「选择 JSON 文件…」面板（原生模式的导入入口）。
    ///
    /// ⚠️ 为什么不用 `<input type=file>` 让 WebKit 弹面板：
    /// 那条路要靠 WebKit 把文件交给 web 进程。实测**会偶发交不到** ——
    /// 原生这边面板选好了、文件确实在磁盘上，web 那边 `input.files` 就是空的，
    /// onchange 拿不到文件，导入静默没反应（用户报的就是这个）。
    ///
    /// 原生自己读（用户选过的文件，原生有权限），再把**内容**送回 web，
    /// 中间就没有那个不可靠的环节了。顺带还能给出真正的错误（读不了 / 不是 UTF-8）。
    private func presentImportPanel() {
        guard let window = self.window else { return }
        // 自测模式：直接用指定文件，不弹面板（面板是模态的，会把自测卡死）
        if let f = self.autoImportFile {
            self.deliverImportFile(f)
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.json]
        panel.beginSheetModal(for: window) { [weak self] resp in
            guard let self else { return }
            guard resp == .OK, let url = panel.url else {
                self.bridge.send("importFile", ["name": "", "text": "", "cancelled": true])
                return
            }
            self.deliverImportFile(url)
        }
    }

    /// 读文件，把内容送回 web。
    /// 读失败**也要回话** —— 不回就是"点了没反应"。
    private func deliverImportFile(_ url: URL) {
        do {
            let data = try Data(contentsOf: url)
            guard let text = String(data: data, encoding: .utf8) else {
                bridge.send("importFile", ["name": url.lastPathComponent, "text": "",
                                          "error": L10n.t("error.notUtf8")])
                return
            }
            bridge.send("importFile", ["name": url.lastPathComponent, "text": text])
        } catch {
            bridge.send("importFile", ["name": url.lastPathComponent, "text": "",
                                      "error": error.localizedDescription])
        }
    }

    // MARK: - 贴图（原生自己走一条通道）

    /// 贴图的长边上限（px）和 JPEG 质量。
    ///
    /// ⚠️ 这两个值必须和 web 侧 `src/canvas/image-input.ts` 的
    ///    MAX_DIM / QUALITY 一致 —— 浏览器模式和桌面模式缩出来的图
    ///    应该长得一样。改一边就要改另一边。
    private static let imageMaxDim = 800
    private static let imageQuality: CGFloat = 0.85

    /// 打开「选择图片…」面板（原生模式的贴图入口）。
    ///
    /// ⚠️ 为什么不让 web 用 `<input type=file>`：
    ///   ① 原生侧的面板写死了只收 JSON —— `WKOpenPanelParameters`（本机 SDK）
    ///      只有 allowsMultipleSelection / allowsDirectories，**没有** allowedContentTypes，
    ///      web 那个 accept="image/*" 根本传不过来，用户在面板里选不到图片。
    ///   ② 那条路实测约 1/10 概率 `input.files` 是空的（见 README 坑 7）。
    ///
    /// 原生自己弹面板、自己读文件、**自己缩放**，再把 dataURL 送回 web。
    /// 缩放放在原生这边是因为：一张手机照片 3–5MB，base64 之后 4–7MB，
    /// 塞进 JSON 走 evaluateJavaScript 会卡住主线程；
    /// 缩到长边 ≤800 之后只剩 50KB 左右，传输成本可以忽略。
    private func presentImagePanel() {
        guard let window = self.window else { return }
        self.imagePanelCount += 1
        // 自测模式：直接用指定文件，不弹面板（面板是模态的，会把自测卡死）
        if let f = self.autoImageFile {
            self.deliverImageFile(f)
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = Self.imageTypes
        panel.beginSheetModal(for: window) { [weak self] resp in
            guard let self else { return }
            guard resp == .OK, let url = panel.url else {
                self.bridge.send("imageFile", ["name": "", "dataUrl": "", "w": 0, "h": 0,
                                              "cancelled": true])
                return
            }
            self.deliverImageFile(url)
        }
    }

    /// 面板能选的类型。HEIC 也要收 —— iPhone 照片默认是 HEIC，
    /// 反正原生会转成 JPEG 再送回去。
    ///
    /// 用 filenameExtension 构造而不是 UTType.png / .webp 这种静态成员 ——
    /// 本机 SDK 有些类型（webp）没有静态成员，写死就编不过。
    private static let imageTypes: [UTType] = {
        var t: [UTType] = []
        for ext in ["png", "jpg", "jpeg", "gif", "bmp", "tiff", "webp", "heic", "heif"] {
            if let u = UTType(filenameExtension: ext) { t.append(u) }
        }
        return t
    }()

    /// 读图片 → 缩放 → JPEG → dataURL → 送回 web。
    /// 失败**也要回话** —— 不回就是"点了没反应"。
    private func deliverImageFile(_ url: URL) {
        // ImageIO 这几个 API 都不抛错，失败都返回 nil —— 所以用 guard 一层层退出，
        // 不用 do/catch（写了编译器会警告 catch 不可达）。
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            bridge.send("imageFile", ["name": url.lastPathComponent, "dataUrl": "",
                                      "w": 0, "h": 0, "error": L10n.t("error.cannotReadImage")])
            return
        }
        // 缩略图由 ImageIO 生成：它会**应用 EXIF 方向**，
        // 所以竖着拍的照片不会转 90°（改 width/height 缩放就会留下这个问题）。
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(Self.imageMaxDim),
        ]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
            bridge.send("imageFile", ["name": url.lastPathComponent, "dataUrl": "",
                                      "w": 0, "h": 0, "error": L10n.t("error.cannotDecodeImage")])
            return
        }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            out, UTType.jpeg.identifier as CFString, 1, nil) else {
            bridge.send("imageFile", ["name": url.lastPathComponent, "dataUrl": "",
                                      "w": 0, "h": 0, "error": L10n.t("error.jpegConvertFailed")])
            return
        }
        CGImageDestinationAddImage(dest, img, [
            kCGImageDestinationLossyCompressionQuality: Self.imageQuality,
        ] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else {
            bridge.send("imageFile", ["name": url.lastPathComponent, "dataUrl": "",
                                      "w": 0, "h": 0, "error": L10n.t("error.jpegConvertFailed")])
            return
        }
        let data = out as Data
        let dataUrl = "data:image/jpeg;base64,\(data.base64EncodedString())"
        self.lastImageBytes = data.count
        self.lastImageSize = (img.width, img.height)
        bridge.send("imageFile", [
            "name": url.lastPathComponent,
            "dataUrl": dataUrl,
            "w": img.width,
            "h": img.height,
        ])
    }

    /// 弹保存面板（导出用）。用户取消 → completion(nil)。
    private func presentSavePanel(name: String?, window: NSWindow, completion: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name ?? L10n.t("common.untitled")
        // 类型按文件名扩展名推 —— WKOpenPanelParameters 在本机 SDK 上
        // 只有 allowsMultipleSelection / allowsDirectories 两个公开属性，
        // 拿不到 WebKit 建议的类型。
        let ext = ((name ?? "") as NSString).pathExtension.lowercased()
        if !ext.isEmpty, let type = UTType(filenameExtension: ext) {
            panel.allowedContentTypes = [type]
        }
        panel.beginSheetModal(for: window) { resp in
            completion(resp == .OK ? panel.url : nil)
        }
    }

    /// 等 web 报上来的建议文件名到位。
    ///
    /// 为什么不能直接读：面板请求（WebKit → 原生）和 downloadName 消息（web → 原生）
    /// 是两条独立的异步通道，谁先到不保证。先读为空就弹"common.untitled"，
    /// 后面名字到了也来不及用。
    private func awaitDownloadName(_ done: @escaping (String?) -> Void) {
        if let n = pendingDownloadName {
            pendingDownloadName = nil
            done(n)
            return
        }
        var tries = 0
        func tick() {
            if let n = pendingDownloadName {
                pendingDownloadName = nil
                done(n)
                return
            }
            tries += 1
            if tries >= 40 { done(nil); return }   // 40 × 10ms = 400ms
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { tick() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { tick() }
    }

    func bridge(_ bridge: Bridge, didReceive type: String, payload: [String: Any]) {
        switch type {
        case "viewChanged":
            guard let v = payload["view"] as? String,
                  let i = Self.views.firstIndex(where: { $0.seg == v }) else { return }
            if seg.selectedSegment != i { seg.selectedSegment = i }

        case "searchChanged":
            let q = payload["q"] as? String ?? ""
            if search.stringValue != q { search.stringValue = q }
            lastQuery = q
            lastCount = payload["count"] as? Int ?? 0
            lastMs = payload["ms"] as? Int ?? 0
            updateCountLabel()

        case "downloadName":
            pendingDownloadName = payload["name"] as? String

        case "openImport":
            presentImportPanel()

        case "openImage":
            presentImagePanel()

        case "filterChanged":
            lastFilterCount = payload["n"] as? Int ?? 0
            filterBtn.title = L10n.filterTitle(lastFilterCount)

        case "contextChanged":
            // 原生菜单的勾选态跟着 web 实际值走
            ctxMenuItem?.state = (payload["on"] as? Bool ?? true) ? .on : .off

        case "lockChanged":
            let l = payload["locked"] as? Bool ?? false
            guard l != locked else { return }
            locked = l
            // 锁定期间只剩门禁卡片，留着一排点不动的按钮比没有更糟
            window?.toolbar?.isVisible = !l
            window?.title = L10n.windowTitle(l)

        case "localeChanged":
            // web 侧的语言偏好是权威的（用户在设置面板里可以锁死语言）。
            if let l = L10nLocale.parse(payload["locale"] as? String) {
                L10n.set(l)
            }

        case "themeChanged":
            // web 端的主题选择落到窗口外观上。
            // "auto" = 交还给系统（appearance = nil）；暗色/亮色 = 钉死窗口外观。
            let t = payload["theme"] as? String ?? "auto"
            if t == "auto" {
                followSystemAppearance = true
                if let w = window, w.appearance != nil { w.appearance = nil }
                pushTheme()
            } else {
                followSystemAppearance = false
                let want: NSAppearance? = t == "light" ? NSAppearance(named: .aqua) : NSAppearance(named: .darkAqua)
                if let want, window?.appearance != want { window?.appearance = want }
            }

        default:
            break
        }
    }
}

// MARK: - WKNavigationDelegate

extension MainWindowController: WKNavigationDelegate {
    // 自定义 scheme 加载失败时 WebKit 默认一声不吭，页面停在 about:blank。
    // 这里必须出声，否则症状就是"应用打开了但是全白"。
    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        NSLog("导航失败(provisional) url=\(webView.url?.absoluteString ?? "?") err=\(error)")
    }
    func webView(_ webView: WKWebView,
                 didFail navigation: WKNavigation!,
                 withError error: Error) {
        NSLog("导航失败 url=\(webView.url?.absoluteString ?? "?") err=\(error)")
    }
}

// MARK: - NSToolbarDelegate

extension MainWindowController: NSToolbarDelegate {
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [ToolbarID.viewSeg, .flexibleSpace, ToolbarID.search,
         ToolbarID.count, ToolbarID.filter, ToolbarID.settings, ToolbarID.newItem]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(_ toolbar: NSToolbar,
                 itemForItemIdentifier id: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let item = NSToolbarItem(itemIdentifier: id)
        // label 是**控件下方那行说明文字**，不是控件自己的标题。
        // 控件本身已经带字了（segmented 的"今日/画布/…"、按钮的"filter.title"），
        // 再让 AppKit 在下面补一遍 label，就变成同一个词出现两次 —— 用户报的
        // "导航有重复"就是这个。所以这里 label 一律留空，
        // 需要可读名字的地方写 paletteLabel（只进自定义面板和无障碍，不上屏）。
        item.label = ""
        item.paletteLabel = L10n.t(toolbarPaletteKeys[id] ?? "")
        switch id {
        case ToolbarID.viewSeg:
            item.view = seg
        case ToolbarID.search:
            item.view = search
        case ToolbarID.count:
            item.view = countLabel
        case ToolbarID.filter:
            item.view = filterBtn
        case ToolbarID.settings:
            item.view = settingsBtn
        case ToolbarID.newItem:
            item.view = newBtn
        default:
            return nil          // .flexibleSpace 由 AppKit 自己处理
        }
        toolbarItems[id] = item
        return item
    }
}