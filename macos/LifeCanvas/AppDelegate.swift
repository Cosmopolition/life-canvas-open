//
//  AppDelegate.swift
//  life-canvas macOS 外壳
//
//  applicationDidFinishLaunching 里：建主窗口、设主菜单、首次激活应用。
//  外观不主动覆盖 —— 让 MainWindowController 通过 effectiveAppearance 跟随系统。
//
//  dist 路径解析顺序（首次命中即用）：
//   1. 环境变量 LIFECANVAS_DIST     —— 开发期跑裸 .app 时指定 dist 目录
//   2. Bundle.main/Contents/Resources/dist   —— 装包后的正常路径
//   3. ../Resources/dist（相对可执行）      —— 容错
//   任何一条都拿不到就 crash —— 没 dist 启动也是空壳，不如早死好查
//

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var windowController: MainWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        guard let dist = resolveDist() else {
            fatalError("找不到 dist 目录。设 LIFECANVAS_DIST 环境变量指向构建产物，或把 dist/ 放进 bundle 的 Resources/")
        }

        windowController = MainWindowController(distRoot: dist)
        windowController?.showWindow(nil)

        if CommandLine.arguments.contains("--selftest") {
            // 先清掉上次跑工具留下的临时产物（只在工具路径上做）
            WindowShot.cleanupStaleTempArtifacts()
            // 截图权限拿不到的时候，用它跑断言
            let t = SelfTest(controller: windowController!) { report in
                print(report)
                exit(0)
            }
            windowController?.selfTest = t
            windowController?.startSelfTest()
        }

        // 原生窗口离屏截图：审工具栏 / 标题栏的观感用。
        // 走 AppKit 离屏绘制，不需要「屏幕录制」权限。
        if let cfg = WindowShot.config(from: CommandLine.arguments) {
            let wc = windowController!
            // 先清掉上次跑工具留下的临时产物（只在工具路径上做）
            WindowShot.cleanupStaleTempArtifacts()
            // 尺寸和外观**立刻**设好：外观要在 web 加载之前定下来，
            // 否则工具栏控件要等 appearance 变化后重绘，截出来可能是半成品
            // （控件只剩底色、没画上文字）。
            if let size = cfg.size {
                var f = wc.window!.frame
                f.size = size
                wc.window!.setFrame(f, display: true)
            }
            if let ap = cfg.appearance {
                wc.window!.appearance = ap == "light" ? NSAppearance(named: .aqua) : NSAppearance(named: .darkAqua)
            }
            wc.window!.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)

            // --shot-image：截图前走**真实的贴图链**（原生读文件缩放 → 送回 web → 入库）。
            // 这样截出来的是"图真的贴上去了"的样子，而不是手工塞进去的假状态。
            if let img = cfg.image {
                wc.autoImageFile = URL(fileURLWithPath: img)
            }

            // --shot-view-early：不等 web 就绪就切视图。
            // 用来复现「原生分段控件抢先切视图」的竞态 ——
            // 那条命令会被 Bridge 排队，web 一发 ready 就补发，
            // 而 ready 发生在读库**之前**，画布那时还不存在。
            if cfg.earlyView, let v = cfg.view {
                wc.selectViewByName(v)
            }

            // 等 web **真的进到 app 里**再切视图。
            //
            // ⚠️ 固定等 4 秒是不靠谱的：读库慢的时候（164 条记录 + 首次解密的
            //    PBKDF2 60 万次迭代），web 还没建好 CanvasView，
            //    这时切过去只会得到一个「没定位」的空画布 ——
            //    而且截图看起来还挺正常（只是空的），很容易当成 app 坏了。
            //    __lcVp 是 bootCore 挂的，bootCore 在 CanvasView 建好之后才跑，
            //    所以它是「画布就绪」的可靠信号。
            self.waitForWebReady(wc) {
                if let v = cfg.view, !cfg.earlyView {
                    wc.selectViewByName(v)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                    // --shot-js：先把 web 摆成要截的状态（比如两侧栏收起）。
                    // 必须在 dump 之前跑完 —— dump 是用来**核对**那张状态的，
                    // 顺序反了 dump 的就是上一帧。
                    if let js = cfg.js {
                        // callAsyncJavaScript 而不是 evaluateJavaScript：
                        // 后者不 await Promise —— 脚本里返回 Promise 的话，
                        // 拿到的永远是 null，而且异步写 IndexedDB 还没落盘就被 exit 掐掉。
                        Task { @MainActor in
                            var msg = "ok"
                            if let v = try? await wc.webView.callAsyncJavaScript(
                                js, arguments: [:], in: nil, contentWorld: .page) {
                                msg = String(describing: v)
                            }
                            print("ShotJS: \(msg)")
                            // 等一帧让布局重排（面板宽度是 CSS 变量驱动的栅格）
                            try? await Task.sleep(nanoseconds: 600_000_000)
                            self.dumpWebState(wc) {
                                let url = cfg.outDir.appendingPathComponent("window.png")
                                if let written = WindowShot.capture(window: wc.window!, to: url, stdoutBase64: cfg.stdoutBase64) {
                                    print("WindowShot: 已写出 \(written.path)")
                                    exit(0)
                                }
                                print("WindowShot: 失败")
                                exit(1)
                            }
                        }
                    } else {
                        // 顺便把 web 侧的实际状态打出来：截图只能看画面，
                        // "原生分段高亮的视图" 和 "web 实际显示的视图" 可能对不上，
                        // 这类错位光看截图会误判。
                        self.dumpWebState(wc) {
                            let url = cfg.outDir.appendingPathComponent("window.png")
                            if let written = WindowShot.capture(window: wc.window!, to: url, stdoutBase64: cfg.stdoutBase64) {
                                print("WindowShot: 已写出 \(written.path)")
                                exit(0)
                            }
                            print("WindowShot: 失败")
                            exit(1)
                        }
                    }
                }
            }
        }

        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    // MARK: - 调试

    /// 等 web 真的进到 app 里（CanvasView 建好 = bootCore 跑完）。
    ///
    /// 最多等 20 秒；超时就照常继续 —— 截一张「还没就绪」的图也比完全不截强，
    /// 而且 WebState 会把「其实没就绪」这件事打出来。
    private func waitForWebReady(_ wc: MainWindowController, then: @escaping () -> Void) {
        let deadline = Date().addingTimeInterval(20)
        func poll() {
            wc.webView.evaluateJavaScript("typeof window.__lcVp === 'function'") { res, _ in
                if (res as? Bool) == true { then(); return }
                if Date() >= deadline {
                    print("WindowShot: 等 web 就绪超时（20s），照常继续")
                    then()
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { poll() }
            }
        }
        poll()
    }

    /// 把 web 侧的关键状态打成一行行文本。
    /// 原生分段控件高亮的视图、web 实际显示的视图、当前主题 —— 这三样
    /// 对不上时，界面看着就是"乱的"，但截图看不出是哪一处错位。
    private func dumpWebState(_ wc: MainWindowController, then: @escaping () -> Void) {
        let js = """
        (function(){
          var ids = ['vCanvas','vTl','vLv','vToday','vDetail'];
          var shown = ids.filter(function(id){
            var e = document.getElementById(id);
            return e && !e.hidden && getComputedStyle(e).display !== 'none';
          });
          var seg = document.querySelector('#seg button.on');
          return JSON.stringify({
            shown: shown,
            segOn: seg ? seg.getAttribute('data-v') : null,
            theme: document.documentElement.dataset.theme || 'dark',
            nativeShell: document.documentElement.dataset.nativeShell || null,
            gateHidden: !document.getElementById('gate') || document.getElementById('gate').hidden,
            appHidden: !document.getElementById('app') || document.getElementById('app').hidden,
            hd: getComputedStyle(document.getElementById('app')).getPropertyValue('--hd').trim(),
            emptyHidden: !document.getElementById('canvasEmpty') || document.getElementById('canvasEmpty').hidden,
            nodes: document.getElementById('perf') ? document.getElementById('perf').textContent : '',
            zoom: document.getElementById('zv') ? document.getElementById('zv').textContent : null,
            cvRect: (function(){ var c=document.getElementById('cv'); if(!c) return null; var r=c.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
            cvBacking: (function(){ var c=document.getElementById('cv'); return c ? [c.width, c.height] : null; })(),
            lw: getComputedStyle(document.getElementById('app')).getPropertyValue('--lw').trim(),
            rw: getComputedStyle(document.getElementById('app')).getPropertyValue('--rw').trim(),
            panels: (function(){
              function box(id){ var e=document.getElementById(id); if(!e) return null;
                var r=e.getBoundingClientRect();
                return {w: Math.round(r.width), x: Math.round(r.left), vis: getComputedStyle(e).display !== 'none' && r.width > 0}; }
              return {left: box('left'), main: box('main'), right: box('right')};
            })(),
            splits: (function(){
              function sp(id){ var e=document.getElementById(id); if(!e) return null;
                var r=e.getBoundingClientRect();
                return {x: Math.round(r.left), w: Math.round(r.width), vis: getComputedStyle(e).display !== 'none'}; }
              return {l: sp('splitL'), r: sp('splitR')};
            })()
          });
        })()
        """
        wc.webView.evaluateJavaScript(js) { res, err in
            if let err { print("WebState 读取失败: \(err)") }
            else { print("WebState: \(res ?? "?")") }
            then()
        }
    }

    // MARK: - 路径

    /// 挑一个**真的读得到**的 dist 目录。
    ///
    /// ⚠️ 为什么不能用 `fileExists` 判存在：
    ///    打包好的 .app 带 App Sandbox，**读不到容器外**的路径。
    ///    `LIFECANVAS_DIST=~/Desktop/.../dist` 时目录"存在"（stat 得到），
    ///    但 SchemeHandler 真正去读文件会被沙盒拒掉 → 导航 -1100 →
    ///    页面停在 about:blank → 自测全线假红（"应用坏了"的假象）。
    ///    所以这里必须验**可读**（读 index.html 本身），不是验目录存在。
    private func resolveDist() -> URL? {
        if let env = ProcessInfo.processInfo.environment["LIFECANVAS_DIST"],
           let d = Self.readableDist(env) {
            return d
        }
        if let res = Bundle.main.resourcePath {
            let bundled = res + "/dist"
            if let d = Self.readableDist(bundled) { return d }
        }
        // 容错：可能从 .app/Contents/MacOS 跑出来的临时场景
        let exe = Bundle.main.bundleURL.appendingPathComponent("../Resources/dist").standardizedFileURL
        if let d = Self.readableDist(exe.path) { return d }
        return nil
    }

    /// 目录里能**真读到 index.html** 才算可用。读不到就当没有。
    private static func readableDist(_ path: String) -> URL? {
        let index = URL(fileURLWithPath: path).appendingPathComponent("index.html")
        guard FileManager.default.isReadableFile(atPath: index.path) else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
    }
}
