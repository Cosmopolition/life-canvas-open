//
//  L10n.swift
//  原生外壳（菜单栏 / 工具栏 / 系统对话框）的文案层。
//
//  跟 web 侧 src/i18n/strings.ts 是**同一套设计**：
//    - 键 = **英文 slug**（'view.today'），中英文各存一份
//    - 插值占位符写成 {param}，两边用同一组
//    - 查不到就退回键本身（宁可露出键名，也不要空白）
//
//  ★ 两边共用的 slug，中英文必须**逐字一致** ——
//    scripts/check-native-i18n.ts 会核对这件事：
//    菜单栏写 "Today"、网页写 "Today"，改了一边忘了另一边是最难查的那种不一致。
//
//  ★ 语言是谁说了算：
//    web 侧的偏好存在 localStorage 里（用户可以在设置面板里锁死语言），
//    所以 **web 是权威**。原生这一侧只负责两件事：
//      ① web 还没加载时，先按系统语言摆一个不刺眼的默认值；
//      ② web 报告了新语言之后，把菜单 / 工具栏 / 窗口标题整体重刷一遍。
//
//  ⚠️ 不要在这里放业务词（节点类型、状态值那些）—— 那是数据契约，
//     翻译它们等于改库里的数据。原生这边只管"外壳自己说的话"。
//

import Foundation

/// 界面语言。和 web 侧的 Locale 一一对应。
enum L10nLocale: String, CaseIterable {
    case zhCN = "zh-CN"
    case enUS = "en-US"

    /// 按系统语言推默认值。
    ///
    /// 用 Locale.preferredLanguages 而不是 Locale.current：
    /// 前者会**遵守 macOS 的"每个 App 单独设语言"**（系统设置 → 通用 → 语言与地区），
    /// 而 App 的 Info.plist 里已经声明了 zh-Hans / en 两种语言，所以那个开关是生效的。
    static func detect() -> L10nLocale {
        let lang = Locale.preferredLanguages.first ?? "zh-Hans"
        return lang.lowercased().hasPrefix("zh") ? .zhCN : .enUS
    }

    /// 从 web 侧报来的字符串解析。认不出来就当没报（保持原样）。
    static func parse(_ raw: String?) -> L10nLocale? {
        guard let raw else { return nil }
        return L10nLocale(rawValue: raw)
    }
}

enum L10n {
    /// **系统**语言。报给 web 的就是它。
    ///
    /// ⚠️ 跟 `locale` 分开是必须的：
    ///    `locale` = 当前**显示**的语言（web 说是什么就是什么），
    ///    `systemLocale` = 系统**跟随**的语言（用户没锁过语言时该是什么）。
    ///    两者混为一谈的话，"跟随系统"会变成"跟随上次选过的语言" ——
    ///    用户在设置里锁过英文再切回跟随系统，指望回到中文，却停在英文。
    static let systemLocale: L10nLocale = L10nLocale.detect()

    /// 记住上次 web 报来的语言（UserDefaults）。
    private static let persistedKey = "lifeCanvas.locale"

    /// 当前语言。默认按系统语言猜；web 起来之后会被 web 的偏好覆盖。
    ///
    /// ⚠️ 为什么要记住上次那个（而不是每次都按系统语言起）：
    ///    用户在设置里锁过英文的话，系统语言是中文 —— 原生默认按系统显示中文，
    ///    但用户明明要的是英文。所以记住用户选过的那个。
    static var locale: L10nLocale {
        if let raw = UserDefaults.standard.string(forKey: persistedKey),
           let l = L10nLocale(rawValue: raw) {
            return l
        }
        return systemLocale
    }

    /// web 报了新语言 —— 存下来，并通知界面重刷。
    static func set(_ l: L10nLocale) {
        UserDefaults.standard.set(l.rawValue, forKey: persistedKey)
        onChange?()
    }

    /// 界面重刷的回调（MainWindowController 装上）。
    static var onChange: (() -> Void)?

    // MARK: - 取文案

    /// 取文案。键 = 英文 slug。
    static func t(_ key: String) -> String {
        guard let e = table[key] else { return key }
        return locale == .enUS ? e.en : e.zh
    }

    /// 取带参数的文案：把 {param} 换成实参。
    ///
    /// ⚠️ 具名占位符，不是 {0}/{1} —— 跟 web 侧同一套写法。
    ///    （旧实现按下标替换，而表里写的是 {n}/{ms}，结果计数标签一直显示
    ///     字面占位符 —— 这就是为什么这里必须用具名。）
    static func t(_ key: String, _ params: [String: String]) -> String {
        var s = t(key)
        for (name, value) in params {
            s = s.replacingOccurrences(of: "{\(name)}", with: value)
        }
        return s
    }

    /// 取带一个参数的文案（大部分动态文案只带一个）。
    static func t(_ key: String, _ name: String, _ value: String) -> String {
        t(key, [name: value])
    }

    /// 搜索结果数："3 个 · 12ms"
    static func countText(_ n: Int, _ ms: Int) -> String {
        t("native.countAndMs", ["n": String(n), "ms": String(ms)])
    }

    /// 筛选按钮："筛选 3"
    static func filterTitle(_ n: Int) -> String {
        n > 0 ? t("native.filterWithCount", "n", String(n)) : t("filter.title")
    }

    /// 窗口标题（锁定态带后缀）
    static func windowTitle(_ locked: Bool) -> String {
        locked ? t("app.nameLocked") : t("app.name")
    }

    // MARK: - 文案表

    /// slug → (中文, English)
    ///
    /// ⚠️ 与 web 侧共用的 slug，两边的中英文必须**逐字一致**
    ///    （scripts/check-native-i18n.ts 守着这条）。
    private static let table: [String: (zh: String, en: String)] = [
        // 应用 / 窗口
        "app.name": ("人生画布", "Life Canvas"),
        "app.nameLocked": ("人生画布（已锁定）", "Life Canvas (locked)"),
        "common.untitled": ("未命名", "Untitled"),

        // 视图分段
        "view.today": ("今日", "Today"),
        "view.canvas": ("画布", "Canvas"),
        "view.timeline": ("时间轴", "Timeline"),
        "view.list": ("列表", "List"),
        // ⚠️ 周历这一格原生用短名（分段控件放不下 "Week calendar"），
        //    所以它**不共用** web 的 view.weekCalendar —— 各用各的 slug。
        "native.weekCalendar": ("周历", "Week"),

        // 工具栏
        "native.searchPlaceholder": ("搜索点、标签、内容", "Search nodes, tags, content"),
        "filter.title": ("筛选", "Filter"),
        "native.filterWithCount": ("筛选 {n}", "Filter {n}"),
        "action.settings": ("设置", "Settings"),
        "action.recordButton": ("＋ 记录", "＋ Record"),
        "native.results": ("结果数", "Results"),
        "native.record": ("记录", "Record"),
        "native.countAndMs": ("{n} 个 · {ms}ms", "{n} found · {ms}ms"),

        // 菜单
        "native.aboutApp": ("关于人生画布", "About Life Canvas"),
        "native.settingsEllipsis": ("设置…", "Settings…"),
        "native.hideApp": ("隐藏人生画布", "Hide Life Canvas"),
        "native.quitApp": ("退出人生画布", "Quit Life Canvas"),
        "native.menuFile": ("文件", "File"),
        "native.newRecord": ("新建记录", "New Record"),
        "native.importJsonEllipsis": ("导入 JSON…", "Import JSON…"),
        "native.exportEllipsis": ("导出…", "Export…"),
        "native.menuEdit": ("编辑", "Edit"),
        "native.undo": ("撤销", "Undo"),
        "native.redo": ("重做", "Redo"),
        "native.cut": ("剪切", "Cut"),
        "native.copy": ("拷贝", "Copy"),
        "native.paste": ("粘贴", "Paste"),
        "native.selectAll": ("全选", "Select All"),
        "native.menuView": ("视图", "View"),
        "native.focusSearchResults": ("聚焦搜索结果", "Focus Search Results"),
        "action.resetCanvas": ("重置画布", "Reset canvas"),
        "native.fullScreen": ("全屏", "Full Screen"),
        "action.search": ("搜索", "Search"),
        "native.focusSearchField": ("聚焦搜索框", "Focus Search Field"),
        "search.relationContext": ("关系上下文", "Relation context"),
        "native.menuWindow": ("窗口", "Window"),
        "native.minimize": ("最小化", "Minimize"),
        "native.zoom": ("缩放", "Zoom"),
        "native.bringAllToFront": ("前置全部窗口", "Bring All to Front"),
        "native.help": ("帮助", "Help"),
        "help.shortcuts": ("快捷键", "Keyboard shortcuts"),

        // 系统对话框
        "native.notice": ("提示", "Notice"),
        "native.confirm": ("确认", "Confirm"),
        "native.input": ("输入", "Input"),
        "native.ok": ("好", "OK"),
        "action.ok": ("确定", "OK"),
        "action.cancel": ("取消", "Cancel"),

        // 原生读文件的报错
        "error.notUtf8": ("不是 UTF-8 文本文件", "Not a UTF-8 text file"),
        "error.cannotReadImage": ("读不出这张图", "Cannot read this image"),
        "error.cannotDecodeImage": ("这张图解不开", "Cannot decode this image"),
        "error.jpegConvertFailed": ("转 JPEG 失败", "Failed to convert to JPEG"),
    ]
}
