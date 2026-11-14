//
//  WindowShot.swift
//  把原生窗口（含标题栏 / 工具栏）离屏渲染成 PNG。
//
//  为什么不用 screencapture / CGWindowListCreateImage：
//  那两条路都要「屏幕录制」权限，在自动化环境里拿不到 —— 截出来是空白。
//  这里走 AppKit 自己的离屏绘制：取窗口的 theme frame（标题栏 + 工具栏
//  + 内容区都在这一层视图树里），cacheDisplay 进 bitmap rep。
//  不碰屏幕缓冲区，因此不需要任何权限。
//
//  用法：
//    LifeCanvas --shot <outDir> [--shot-view canvas|today|tl|lv|wk]
//                            [--shot-size 1280x840] [--shot-appearance dark|light]
//                            [--shot-js "<一段 JS>"]
//
//  --shot-js：截图**之前**在 web 里先跑一段 JS。
//  为什么需要：有些状态没法从原生侧点出来（比如「两侧栏都收起的全屏画布」，
//  原生没有对应按钮）。没有这个开关就只能靠手点，然后手点的那一帧和
//  离屏渲染的那一帧往往是两回事 —— 截出来的不是自己点的那个状态。
//
//  产出：<outDir>/window.png
//
//  已知限制：工具栏里的分段控件和圆角按钮是 vibrancy 材质画的，
//  离屏绘制时材质会回退成白色 —— 深色外观下截出来是"白底白字"（控件变白块），
//  浅色外观下正常。**这不是 app 的 bug**，是 cacheDisplay 不做材质合成。
//  要看深色下的真实观感，请直接开 app 切系统深色。
//

import AppKit

enum WindowShot {
    /// theme frame 视图树。返回 nil 表示窗口还没建好。
    private static func frameView(of window: NSWindow) -> NSView? {
        window.contentView?.superview
    }

    /// 清掉**上一次**跑截图 / 自测留下的临时产物。
    ///
    /// ⚠️ 为什么需要：截图失败退回容器临时目录时，每次跑都会留一个
    ///    `lifecanvas-shot-<pid>/`；自测也会留 `lc-selftest-*`。
    ///    跑几十次就是几十个目录，白占地方。
    ///
    /// 只在**工具路径**上跑（截图 / 自测），正常启动不碰 —— 删文件这种事
    /// 不该发生在用户双击 app 的时候。
    static func cleanupStaleTempArtifacts() {
        let tmp = FileManager.default.temporaryDirectory
        let me = ProcessInfo.processInfo.processIdentifier
        guard let items = try? FileManager.default.contentsOfDirectory(
            at: tmp, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let stale = Date().addingTimeInterval(-3600)
        for u in items {
            let name = u.lastPathComponent
            // 本次进程自己的目录不能删（外层脚本还要拷它）
            if name.hasPrefix("lifecanvas-shot-"),
               let pid = Int(name.dropFirst("lifecanvas-shot-".count)), pid == me { continue }
            if name.hasPrefix("lifecanvas-shot-") || name.hasPrefix("lc-selftest-") {
                try? FileManager.default.removeItem(at: u)
                continue
            }
            // 顶层的老图片：截图/验收用的素材，不是用户数据
            if name.hasSuffix(".png"),
               let d = try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
               d < stale {
                try? FileManager.default.removeItem(at: u)
            }
        }
    }

    /// 离屏渲染窗口。返回实际写出的文件 URL（沙盒拒写时会退回容器临时目录）。
    ///
    /// ⚠️ `stdoutBase64` = true 时**不写文件**，改成把 PNG 的 base64 打到 stdout。
    ///    为什么需要这条路：macOS 的 **App Data Protection** 会挡住外部进程读
    ///    `~/Library/Containers/<id>/Data` 里的文件内容（stat 可以，读不行）。
    ///    沙盒里的 app 只能写自己的容器 → 截图落在容器里 → 外面的脚本读不出来。
    ///    走 stdout 就绕开了整条链路：app 打印，外层解码。
    @discardableResult
    static func capture(window: NSWindow, to url: URL, stdoutBase64: Bool = false) -> URL? {
        guard let frame = frameView(of: window) else {
            NSLog("WindowShot: 拿不到 theme frame")
            return nil
        }
        // 工具栏是 vibrancy 材质，直接 cacheDisplay 可能截不到背景。
        // 先把窗口标记成不需要 vibrancy 的普通层级渲染路径：
        // 强制 layout + display，确保这一帧是新的。
        window.displayIfNeeded()
        frame.layoutSubtreeIfNeeded()
        frame.displayIfNeeded()

        guard let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else {
            NSLog("WindowShot: 建不出 bitmap rep")
            return nil
        }
        frame.cacheDisplay(in: frame.bounds, to: rep)

        guard let data = rep.representation(using: .png, properties: [:]) else {
            NSLog("WindowShot: PNG 编码失败")
            return nil
        }

        if stdoutBase64 {
            print("SHOTPNG:\(data.base64EncodedString())")
            fflush(stdout)
            return url
        }

        // 沙盒里 app 只能写自己的容器。目标目录写不进去就退回容器临时目录，
        // 把路径打出来给外层脚本拷 —— 截图这条路不能被沙盒掐断。
        var targets = [url]
        targets.append(FileManager.default.temporaryDirectory
            .appendingPathComponent("lifecanvas-shot-\(ProcessInfo.processInfo.processIdentifier)/window.png"))

        for target in targets {
            do {
                try FileManager.default.createDirectory(
                    at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: target)
                return target
            } catch {
                NSLog("WindowShot: 写 \(target.path) 失败（\(error.localizedDescription)）")
            }
        }
        return nil
    }

    /// 从命令行参数里解析 --shot 的配置。
    struct Config {
        var outDir: URL
        var view: String?
        var size: NSSize?
        /// 强制窗口外观（dark / light）。用于截「系统深色时」的样子，
        /// 不用真去改系统设置。
        var appearance: String?
        /// 截图前先在 web 里跑的 JS。用来复现原生侧点不出来的状态。
        var js: String?
        /// 立刻切视图（不等 web 就绪）。
        /// 用来复现「原生分段控件抢先切视图、web 还在读库」的竞态 ——
        /// 那条命令会在 web ready 时补发，而 ready 早于画布创建。
        var earlyView: Bool
        /// 贴图用的图片文件路径。截图前会走**真实的贴图链**：
        /// web 发 openImage → 原生读文件缩放 → 送回 web → 入库。
        var image: String?
        /// 把 PNG 以 base64 打到 stdout（不写文件）。
        /// 绕开 macOS 的 App Data Protection（容器里的文件外部进程读不了内容）。
        var stdoutBase64: Bool
    }

    static func config(from args: [String]) -> Config? {
        guard let i = args.firstIndex(of: "--shot") else { return nil }
        let outDir = i + 1 < args.count
            ? URL(fileURLWithPath: args[i + 1], isDirectory: true)
            : URL(fileURLWithPath: FileManager.default.currentDirectoryPath + "/shots/native", isDirectory: true)

        var view: String? = nil
        if let j = args.firstIndex(of: "--shot-view"), j + 1 < args.count { view = args[j + 1] }

        var size: NSSize? = nil
        if let j = args.firstIndex(of: "--shot-size"), j + 1 < args.count {
            let parts = args[j + 1].split(separator: "x")
            if parts.count == 2, let w = Double(parts[0]), let h = Double(parts[1]) {
                size = NSSize(width: w, height: h)
            }
        }

        var appearance: String? = nil
        if let j = args.firstIndex(of: "--shot-appearance"), j + 1 < args.count { appearance = args[j + 1] }

        var js: String? = nil
        if let j = args.firstIndex(of: "--shot-js"), j + 1 < args.count { js = args[j + 1] }

        let earlyView = args.contains("--shot-view-early")

        var image: String? = nil
        if let j = args.firstIndex(of: "--shot-image"), j + 1 < args.count { image = args[j + 1] }

        let stdoutBase64 = args.contains("--shot-stdout")

        return Config(outDir: outDir, view: view, size: size, appearance: appearance,
                      js: js, earlyView: earlyView, image: image, stdoutBase64: stdoutBase64)
    }
}
