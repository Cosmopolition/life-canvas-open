//
//  SelfTest.swift
//  无头验证外壳。比截图可靠 —— 每条都是断言后的实测值。
//
//  用法：
//    ./LifeCanvas.app/Contents/MacOS/LifeCanvas --selftest
//
//  覆盖计划里"能程序化验证"的那几条：
//    · web 顶栏是否真的让位（header display:none 且那条 52px 轨真的塌成 0）
//    · 四个断点下三列实际宽度 / 两侧栏是否变抽屉
//    · 画布 CSS 尺寸与后备存储是否一致（ResizeObserver 是否生效，有没有被拉伸）
//    · 原生 → web 的 view / search 单向链路
//    · web → 原生的回执（viewChanged / searchChanged）
//
//  不能程序化验证的（需要真人操作）：观感、拖拽解锁、Touch ID。列在文末。
//

import AppKit
import WebKit

final class SelfTest {
    private weak var controller: MainWindowController!
    private var webView: WKWebView { controller.webView }
    private let finish: (String) -> Void
    private var lines: [String] = []
    private var step = 0
    private var failures = 0
    private var skips = 0
    /// 自测期间暂存的画布焦点（主题 / 阶段）—— 测完要原样还给用户
    private var savedFocusTheme: String? = nil
    private var savedFocusStage: String? = nil
    /// 自测前用户的语言偏好（'auto' / 'zh-CN' / 'en-US'）—— 测完要还原
    private var savedLocalePref: String = "auto"

    init(controller: MainWindowController, finish: @escaping (String) -> Void) {
        self.controller = controller
        self.finish = finish
    }

    // MARK: - 输出

    private func say(_ s: String) { lines.append(s) }

    private func expect(_ ok: Bool, _ label: String, _ detail: String) {
        if !ok { failures += 1 }
        say("\(ok ? "PASS" : "FAIL")  \(label)\n        \(detail)")
    }

    private func fail(_ label: String, _ detail: String) {
        failures += 1
        say("FAIL  \(label)\n        \(detail)")
        advance()
    }

    /// 跳过：**前置条件不成立**（比如库是空的），所以这条断言这次没法跑。
    ///
    /// ⚠️ 为什么必须跟 FAIL 分开：前置条件失败如果报成 FAIL，
    ///    看起来就像"功能坏了" —— 下一个人会去查 bug，
    ///    其实只是"这条断言这次没法跑"。比如空库时"库里有点可以贴图"必然不成立，
    ///    那是环境问题，不是贴图功能有问题。
    ///    报 SKIP 就把"没测到"和"测出了问题"分成两类，失败率才有意义。
    private func skip(_ label: String, _ detail: String) {
        skips += 1
        say("SKIP  \(label)\n        \(detail)")
    }

    // MARK: - JSON 取值（JSONSerialization 给的是 Any，统一在这里收口）

    private func s(_ j: [String: Any], _ k: String, _ dflt: String = "?") -> String {
        guard let v = j[k] else { return dflt }
        return (v as? String) ?? "\(v)"
    }
    private func d(_ j: [String: Any], _ k: String, _ dflt: Double = -1) -> Double {
        (j[k] as? NSNumber)?.doubleValue ?? dflt
    }
    private func b(_ j: [String: Any], _ k: String) -> Bool {
        (j[k] as? NSNumber)?.boolValue ?? false
    }
    private func arr(_ j: [String: Any], _ k: String) -> [String] {
        (j[k] as? [Any])?.map { "\($0)" } ?? []
    }
    private func json(_ raw: String) -> [String: Any] {
        guard let data = raw.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return o
    }

    // MARK: - 驱动

    func run() {
        DispatchQueue.main.async { self.advance() }
    }

    private lazy var steps: [() -> Void] = [
        dismissGates,
        forceChineseLocale,
        disableTransitions,
        shellMode,
        selectCanvasView,
        resetPanelLayout,
        splitterDrag,
        canvasRepaintOnResize,
        // ⚠️ 贴图这一步必须在**画布视图还开着**的时候跑 ——
        //    后面 nativeToWebView 会切到时间轴，画布一隐藏，
        //    「画布上画出了这张图」这条断言就恒假（读到的是一张空画布）。
        imageUpload,
        resize(1440), resize(1100), resize(900), resize(700),
        nativeToWebView,
        nativeToWebWeekView,
        nativeToWebSearch,
        spaceIsolation,
        weekImport,
        imageCard,
        reviewCard,
        nativeSettingsOpensPanel,
        nativeResetCanvas,
        filePanelIsWired,
        versionShown,
        localeSync,
        restorePanelLayout,
        restoreLocale,
    ]

    /// 自测开始前：把侧栏摆成「两栏都展开」的确定布局，并记下用户原来的布局。
    ///
    /// ⚠️ 为什么必须做：侧栏宽度是**用户偏好**（会存进设置），
    ///    用户要是把左栏收起过，那么「拖左栏 → 画布变宽」这条断言
    ///    从一开始就不成立（画布本来就已经是满宽了）——
    ///    自测会红，但那是用户的布局造成的，不是 app 坏了。
    ///    自测不能被用户的偏好牵着走。
    private func resetPanelLayout() {
        js("""
        (function(){
          if (!window.__lcPanels || !window.__lcSetPanels) {
            window.__st = JSON.stringify({ ok: 0, why: 'no __lcPanels hook' }); return;
          }
          var p = window.__lcPanels();
          window.__lcSavedPanels = p.cur;
          window.__lcSetPanels(p.def.left, p.def.right, false);
          window.__st = JSON.stringify({ ok: 1, cur: p.cur, def: p.def });
        })()
        """)
        poll("把侧栏摆成确定布局") { [weak self] j in
            guard let self else { return }
            self.expect(self.b(j, "ok"),
                        "自测前侧栏布局可控（钩子在）",
                        "cur=\(self.s(j, "cur", "?")) def=\(self.s(j, "def", "?"))")
            self.advance()
        }
    }

    /// 贴图整条链：原生弹面板 → 读文件 → ImageIO 缩放 → 送回 web → 入库 → 画布上画出来。
    ///
    /// ⚠️ 为什么这条不能省：
    ///    贴图原来走 `<input type=file>`，而原生侧的面板写死了只收 JSON
    ///    （WKOpenPanelParameters 没有类型字段，web 的 accept="image/*" 传不过来），
    ///    桌面端**根本选不了图**。再加上那条路约 1/10 概率拿不到文件，
    ///    等于双重不可靠。
    ///
    ///    这条断言盯的是**用户路径**：造一张真图 → 点检视面板里的「贴图」按钮
    ///    → 原生读文件缩放 → 送回 web → 图进了库 → 画布上真的画出来了。
    ///    光断言"面板请求到了"证明不了图真的入库、真的画出来了。
    ///
    /// ⚠️ 自测跑在**用户真实容器**上 —— 贴完必须把图拿掉（`__lcRemoveImage`），
    ///    而且要**按 id 精确删**：删"第一个有图的点"会连用户自己的照片一起删掉。

    private func imageUpload() {
        // ① 造一张 1200×800 的真 PNG（洋红底 + 左上角一个白方块），放到容器临时目录。
        //    尺寸要 > 800 —— 才能验出"原生确实缩放过"。
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("lc-selftest-img-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("sample.png")
        guard let png = Self.makeTestPNG(width: 1200, height: 800),
              (try? png.write(to: file)) != nil else {
            fail("造一张测试图", "生成 PNG 失败")
            advance()
            return
        }
        // ①' 先把画布焦点摆成"什么都看得见"的状态。
        //
        //    ⚠️ 为什么必须这么做：app 开机默认落在某个阶段上，
        //    而**焦点外的点在 renderer 里是直接 continue 的 —— 根本不画**。
        //    于是图明明贴上了、也 decode 完了，画布上却一个洋红像素都数不到，
        //    症状和"图根本没画出来"**长得一模一样**（都是 0 像素），
        //    修法却完全不同。
        //
        //    自测跑在用户真实数据上，焦点是用户自己设的 ——
        //    不摆成确定状态，这条断言就是**看用户设置**的断言。
        //    （原来这条断言的失败率在 50% 上下，改动前后都一样。）
        let savedFocus = (js("JSON.stringify((window.__lcFocus && window.__lcFocus()) || {})") as? [String: Any]) ?? [:]
        savedFocusTheme = savedFocus["themeId"] as? String
        savedFocusStage = savedFocus["stageId"] as? String
        _ = js("JSON.stringify((window.__lcSetFocus && window.__lcSetFocus(null, null)) || {})")

        // ② 原生侧：面板不弹，直接读这个文件（面板是模态的，会把自测卡死）
        controller.autoImageFile = file
        let beforePanels = controller.imagePanelCount
        let beforeOpen = controller.openPanelCount

        // ③ web 侧：挑一个**当前没有图**的点选中。
        //    ⚠️ 检视面板的按钮文案按状态变：已经有图的点显示「换图（上传）」，
        //       没图的才显示「贴图（…）」。选中一个带图的点，
        //       按「贴图」两个字找按钮就永远找不到 ——
        //       看起来像功能坏了，其实只是找错了按钮。
        js("""
        (function(){
          var id = window.__lcPlainNodeId ? window.__lcPlainNodeId() : null;
          if (id) window.__lcSelect(id);
          window.__st = JSON.stringify({ ok: id ? 1 : 0, id: id,
            nodes: window.__lcState ? window.__lcState().nodes : -1 });
        })()
        """)
        poll("贴图：选中一个没图的点") { [weak self] j in
            guard let self else { return }
            let nodes = Int(self.d(j, "nodes"))
            if nodes == 0 {
                // ⚠️ 库是空的 → 没有点可以贴图。
                //    **这不是产品问题**：新用户第一次装 app 就是空库，
                //    贴图功能根本没东西可贴。报 FAIL 会让下一个人以为贴图坏了，
                //    去查一个不存在的 bug —— 所以这里报 SKIP。
                self.skip("库里有点可以贴图",
                          "库是空的（0 个点）→ 贴图这步没法跑，跳过（不是产品问题）")
                self.cleanupImage(nil, dir: dir)
                self.advance()
                return
            }
            self.expect(self.b(j, "ok"),
                        "库里有点可以贴图",
                        "id=\(self.s(j, "id", "无")) 节点数=\(nodes)")
            guard self.b(j, "ok") else { self.cleanupImage(nil, dir: dir); self.advance(); return }
            let nodeId = self.s(j, "id", "")

            // ④ 点检视面板里的「贴图」按钮（和用户手点同一条路）
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                guard let self else { return }
                self.js("""
                (function(){
                  var btns = Array.from(document.querySelectorAll('#right button'));
                  var b = btns.find(function(x){ return (x.textContent||'').indexOf('贴图') === 0; });
                  if (b) b.click();
                  window.__st = JSON.stringify({
                    ok: b ? 1 : 0,
                    label: b ? b.textContent : null,
                    all: btns.map(function(x){ return x.textContent; }).join(' / ')
                  });
                })()
                """)
                self.poll("贴图：点按钮") { [weak self] jj in
                    guard let self else { return }
                    self.expect(self.b(jj, "ok"),
                                "检视面板里有「贴图」按钮",
                                "label=\(self.s(jj, "label", "没找到")) 按钮清单=\(self.s(jj, "all", "-"))")

                    // ⑤ 等图入库。
                    //    ⚠️ 必须按 **id** 精确等，不能等"库里有 N 张图"：
                    //       用户自己的库里可能已经有图，那个条件立刻就成立，
                    //       断言会"通过"，而实际上这次贴图根本没发生。
                    self.waitJS(
                        "((window.__lcNodeImage && window.__lcNodeImage('\(nodeId)').has) ? 1 : 0)",
                        timeout: 8.0) { [weak self] got in
                        guard let self else { return }
                        let c = self.controller!
                        self.expect(got,
                                    "图进了库（web 侧那个点上有 imageData）",
                                    "node=\(nodeId)")
                        self.expect(c.imagePanelCount > beforePanels,
                                    "原生侧收到贴图请求（自己弹面板读文件）",
                                    "imagePanelCount=\(c.imagePanelCount)")
                        self.expect(c.openPanelCount == beforeOpen,
                                    "贴图**不走** WebKit 的文件输入（那条路选不了图）",
                                    "openPanelCount=\(c.openPanelCount)")
                        self.expect(c.lastImageBytes > 0,
                                    "原生把图读出来并缩放成了 JPEG",
                                    "bytes=\(c.lastImageBytes) 尺寸=\(c.lastImageSize.w)×\(c.lastImageSize.h)")
                        let longEdge = max(c.lastImageSize.w, c.lastImageSize.h)
                        self.expect(longEdge > 0 && longEdge <= 800,
                                    "缩放后长边 ≤ 800px（1200×800 → 800×533）",
                                    "长边=\(longEdge)")

                        self.readJS("JSON.stringify(window.__lcNodeImage ? window.__lcNodeImage('\(nodeId)') : {})") { raw in
                            let img = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] ?? [:]
                            let prefix = img["prefix"] as? String ?? ""
                            let len = (img["len"] as? NSNumber)?.intValue ?? 0
                            let iw = (img["w"] as? NSNumber)?.intValue ?? 0
                            let ih = (img["h"] as? NSNumber)?.intValue ?? 0
                            self.expect(prefix.hasPrefix("data:image/jpeg;base64,"),
                                        "存的是原生缩好的 JPEG（不是原图）",
                                        "prefix=\(prefix)")
                            self.expect(len > 0 && iw == c.lastImageSize.w && ih == c.lastImageSize.h,
                                        "库里那张图的尺寸和原生送回来的一致",
                                        "len=\(len) \(iw)×\(ih) 原生=\(c.lastImageSize.w)×\(c.lastImageSize.h)")

                            // ⑥ 画布上要**真的画出这张图**。
                            //    先等图片 decode 完（等**信号**，不是等时长）——
                            //    decode 没完就采样，画到的还是占位底色。
                            self.waitJS(
                                "((window.__lcImageReady && window.__lcImageReady('\(nodeId)')) ? 1 : 0)",
                                timeout: 8.0) { [weak self] _ in
                                guard let self else { return }
                                self.checkCanvasShowsImage(nodeId, scale: 1, minPixels: 500, dir: dir)
                            }
                        }
                    }
                }
            }
        }
    }

    /// 断言「画布上真的画出了这张图」：把点摆到视口中央，等一帧，数它的特征色像素。
    ///
    /// ⚠️ 为什么分两步（先确认在可视区，再数像素）：
    ///    「图没画出来」和「压根没看对地方」这两种失败长得一模一样（都是 0 个像素），
    ///    但修法完全不同。先把"看得见"钉死，后面的像素数才有意义。
    ///
    /// ⚠️ 为什么等一帧再数：居中只是改了视口，**画布要等下一帧才重画**。
    private func checkCanvasShowsImage(_ nodeId: String, scale: Double, minPixels: Int, dir: URL) {
        js("window.__st = JSON.stringify(window.__lcCenterOn('\(nodeId)', \(scale)) || {});")
        poll("贴图：把点摆到视口中央（scale=\(scale)）") { [weak self] cj in
            guard let self else { return }
            let inView = (cj["inView"] as? NSNumber)?.boolValue ?? false
            self.expect(inView,
                        "要断言的那个点在画布可视区里（scale=\(scale)）",
                        "scale=\(self.s(cj, "scale", "?")) 中心=(\(self.s(cj, "cx", "?")),\(self.s(cj, "cy", "?"))) 画布=\(self.s(cj, "cw", "?"))×\(self.s(cj, "ch", "?"))")
            guard inView else { self.cleanupImage(nodeId, dir: dir); self.advance(); return }

            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self else { return }
                self.readJS("String(window.__lcCanvasMagenta ? window.__lcCanvasMagenta() : -1)") { raw in
                    let n = Int(raw) ?? -1
                    let label = scale < 0.45
                        ? "概览（缩到 25%）也画出了这张图（卡片角标）"
                        : "画布上画出了这张图（精细路径：标题旁的缩略图）"
                    self.expect(n > minPixels, label, "洋红像素=\(n)")

                    // 概览路径（缩放 <45%）是最后一步：查完就清理
                    if scale < 0.45 {
                        self.cleanupImage(nodeId, dir: dir)
                        self.advance()
                    } else {
                        // 概览路径：卡片右上角一个封面角标（很小，阈值低一档）
                        self.checkCanvasShowsImage(nodeId, scale: 0.25, minPixels: 20, dir: dir)
                    }
                }
            }
        }
    }

    /// 自测结束：把贴到用户点上的测试图拿掉，删掉临时文件。
    ///
    /// ⚠️ 必须按 id 精确删 —— 「删掉第一个有图的点」会连用户自己的照片一起删掉。
    private func cleanupImage(_ nodeId: String?, dir: URL) {
        // 焦点还回去 —— 自测不能把用户的设置改了（下一轮自测、正常使用都靠它）
        let t = savedFocusTheme.map { "\"\($0)\"" } ?? "null"
        let g = savedFocusStage.map { "\"\($0)\"" } ?? "null"
        _ = js("JSON.stringify((window.__lcSetFocus && window.__lcSetFocus(\(t), \(g))) || {})")
        if let nodeId, !nodeId.isEmpty {
            js("""
            (function(){
              if (window.__lcRemoveImage) window.__lcRemoveImage('\(nodeId)');
              window.__st = JSON.stringify({ ok: 1 });
            })()
            """)
        }
        try? FileManager.default.removeItem(at: dir)
    }

    /// 造一张测试用 PNG（1200×800，洋红底 + 左上角一个白方块）。
    ///
    /// ⚠️ 为什么是洋红：画布配色里**没有洋红** —— 节点色里最接近的 #d47f9a 也差得很远。
    ///    所以「画布上出现了洋红像素」= 「这张图真的画上去了」，
    ///    不会被画布本来的颜色骗过去。
    ///    （比"不同颜色数增加了"精确得多：那个指标会被画布上已有的颜色糊弄。）
    ///
    /// ⚠️ 左上角留一个白方块：肉眼验收时能一眼看出画的是哪张图。
    ///
    /// 尺寸要 > 800 —— 才能验出"原生确实缩放过"。
    private static func makeTestPNG(width: Int, height: Int) -> Data? {
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                         isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor(srgbRed: 1, green: 0, blue: 1, alpha: 1).setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: width, height: height)).fill()
        NSColor.white.setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: width / 8, height: height / 8)).fill()
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])
    }

    /// 自测结束：把用户原来的侧栏布局还回去（连"收起"这个状态一起还）。
    ///
    /// 自测过程里拖过分隔条 → 会写进设置。不还回去的话，
    /// 用户下次打开 app 发现自己的侧栏被自测改了。
    private func restorePanelLayout() {        js("""
        (function(){
          var s = window.__lcSavedPanels;
          if (!s || !window.__lcSetPanels) { window.__st = JSON.stringify({ ok: 0, why: 'nothing saved' }); return; }
          window.__lcSetPanels(s.left, s.right, true);
          window.__st = JSON.stringify({ ok: 1, restored: s });
        })()
        """)
        poll("把侧栏布局还给用户") { [weak self] j in
            guard let self else { return }
            self.expect(self.b(j, "ok"),
                        "自测后侧栏布局还给用户了",
                        "restored=\(self.s(j, "restored", "?"))")
            self.advance()
        }
    }

    /// 拖分隔条：拖到屏幕边上 → 侧栏收起（画布占满）；双击 → 恢复。
    ///
    /// 合成 pointer 事件就能驱动真实的拖拽逻辑（pointerdown/move/up），
    /// 比读代码可靠 —— 这里的断言盯的是**用户路径**。
    private func splitterDrag() {
        js("""
        (function(){
          var s = document.getElementById('splitL');
          if (!s) { window.__st = JSON.stringify({ ok: 0, why: 'no #splitL' }); return; }
          var left = document.getElementById('left');
          var cv = document.getElementById('cv');
          var before = Math.round(left.getBoundingClientRect().width);
          var cvBefore = Math.round(cv.getBoundingClientRect().width);
          var r = s.getBoundingClientRect();
          function pe(type, x, target) {
            (target || s).dispatchEvent(new PointerEvent(type, {
              clientX: x, clientY: 200, bubbles: true, pointerId: 1, isPrimary: true, buttons: 1
            }));
          }
          // 往屏幕左边缘拖 → 宽度归零 = 收起，画布跟着变宽
          pe('pointerdown', r.left + 6, s);
          pe('pointermove', -200, window);
          pe('pointerup', -200, window);
          var sr = s.getBoundingClientRect();
          window.__st = JSON.stringify({
            ok: 1, before: before, cvBefore: cvBefore,
            after: Math.round(left.getBoundingClientRect().width),
            cvAfter: Math.round(cv.getBoundingClientRect().width),
            splitLeft: Math.round(sr.left),
            splitW: Math.round(sr.width),
            innerW: window.innerWidth,
            collapsed: s.classList.contains('collapsed')
          });
        })()
        """)
        poll("拖分隔条到屏幕边") { [weak self] j in
            guard let self else { return }
            let before = self.d(j, "before")
            let after = self.d(j, "after")
            let cvBefore = self.d(j, "cvBefore")
            let cvAfter = self.d(j, "cvAfter")
            let splitLeft = self.d(j, "splitLeft")
            let splitW = self.d(j, "splitW")
            let innerW = self.d(j, "innerW")
            self.expect(after <= 1,
                        "拖到屏幕边 → 左栏收起（轨道宽度 0；面板还留着 1px 边框）",
                        "before=\(before) after=\(after) raw=[\(j["after"] ?? "?")]")
            self.expect(cvAfter > cvBefore,
                        "左栏收起 → 画布变宽（占满整宽）",
                        "cv \(cvBefore) → \(cvAfter)")
            // 收起后分隔条必须**整个还在屏幕里**。
            // 照着面板边缘摆的话，12px 命中区会有一半跑到屏幕外 ——
            // 屏幕上什么抓手都没有，用户不知道还能拖回去。
            self.expect(splitLeft >= 0 && splitLeft + splitW <= innerW,
                        "收起后分隔条整个留在屏幕内（抓手还在）",
                        "left=\(splitLeft) w=\(splitW) 窗口=\(innerW)")
            self.expect(self.b(j, "collapsed"),
                        "收起态有专门的标记（用来显出那枚小把手）",
                        "collapsed=[\(j["collapsed"] ?? "?")]")
            // 双击恢复
            self.js("""
            var s = document.getElementById('splitL');
            s.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            window.__st = JSON.stringify({ ok: 1 });
            """)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                self.readJS("""
                Math.round(document.getElementById('left').getBoundingClientRect().width)
                """) { raw in
                    let w = Double(raw) ?? -1
                    self.expect(w > 0,
                                "双击分隔条 → 左栏恢复",
                                "width=\(raw)")
                    self.advance()
                }
            }
        }
    }

    /// 画布在 resize 之后必须**当场**就有内容 —— 不等下一帧。
    ///
    /// ⚠️ 为什么这条不能省：
    ///    设 cv.width 会**清空**位图（不是变模糊，是没了）。
    ///    如果 resize() 只置 dirty 等下一帧重绘，那么在下一帧到来之前
    ///    画布是**空白**的 —— 而窗口在后台 / 被遮挡时 rAF 会被节流，
    ///    那一帧可能迟迟不来，画布就一直空着：
    ///    画面上什么都没有，缩放读数却完全正常，很容易被当成"数据没了"。
    ///    （2026-10-23 截屏时撞到过：画布全空，小地图却是满的）
    ///
    /// 怎么验：**同步**读像素。
    /// JS 是单线程的 —— resize 和读像素之间不可能插进一个 rAF 回调，
    /// 所以读到的就是"resize 之后立刻"的状态。
    /// 背景 + 网格点 = 2 种颜色；画了卡片就明显更多。
    private func canvasRepaintOnResize() {
        js("""
        (function(){
          var c = document.getElementById('cv');
          if (!c) { window.__st = JSON.stringify({ ok: 0, why: 'no #cv' }); return; }
          function colors(){
            try {
              var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
              var seen = {}, step = 4 * 53;
              for (var i = 0; i < d.length; i += step) seen[d[i] + ',' + d[i+1] + ',' + d[i+2]] = 1;
              return Object.keys(seen).length;
            } catch (e) { return -1; }
          }
          var old = c.style.cssText;
          var w = c.clientWidth;
          var before = colors();
          // 改画布自身尺寸 + 触发一次 resize（同步路径：window 的 resize 监听）
          c.style.width = Math.max(40, w - 40) + 'px';
          window.dispatchEvent(new Event('resize'));
          var after = colors();          // ← 此刻还没跑过任何一帧
          c.style.cssText = old;
          window.dispatchEvent(new Event('resize'));
          window.__st = JSON.stringify({ ok: 1, before: before, after: after, w: w });
        })()
        """)
        poll("resize 后当场重绘") { [weak self] j in
            guard let self else { return }
            let before = self.d(j, "before")
            let after = self.d(j, "after")
            self.expect(after >= 4,
                        "画布 resize 后当场就有内容（不等下一帧）",
                        "颜色数 resize前=\(before) resize后=\(after)")
            self.advance()
        }
    }

    /// 关掉所有过渡动画。
    ///
    /// 抽屉是靠 translateX 滑出屏外的，宽度保留、只改 transform ——
    /// 断言读的就是这个 transform 的**计算值**。
    /// 而离屏 / 被遮挡的窗口里 CoreAnimation 不推进，
    /// transition 会卡在起始值（identity），于是"收起到屏外"永远断言不过。
    /// 那是测量环境的问题，不是布局的问题 —— 这里直接把过渡关掉，
    /// 让 transform 一步到位，断言才是确定的。
    private func disableTransitions() {
        js("""
        var s = document.getElementById('__st_no_transition');
        if (!s) {
          s = document.createElement('style');
          s.id = '__st_no_transition';
          document.head.appendChild(s);
        }
        s.textContent = '*,*::before,*::after{transition:none !important;animation:none !important}';
        window.__st = JSON.stringify({ ok: 1 });
        """)
        poll("关掉过渡动画") { [weak self] _ in self?.advance() }
    }

    /// 切到画布视图。
    ///
    /// 画布断言读的是 #cv 的 clientWidth —— 视图不是画布时它是 hidden，
    /// 尺寸恒为 0x0，"后备存储 = CSS×DPR"就变成恒真的废断言。
    private func selectCanvasView() {
        controller.selectView(1)     // views: today / canvas / tl / lv / wk（新增的加在末尾，下标不变）
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self else { return }
            self.js("""
            var cv = document.getElementById('cv');
            window.__st = JSON.stringify({
              canvasHidden: document.getElementById('vCanvas').hidden,
              css: cv.clientWidth + 'x' + cv.clientHeight
            });
            """)
            self.poll("切到画布视图") { [weak self] j in
                guard let self else { return }
                self.expect(self.b(j, "canvasHidden") == false,
                            "已切到画布视图（#cv 有尺寸，断言才有效）",
                            "css=\(self.s(j, "css"))")
                // 第一次进画布时要定位（fit 到当前焦点）。
                // ⚠️ 这条盯的是一个真踩过的坑：定位曾经发生在**画布还隐藏**的时候，
                //    隐藏元素尺寸是 0×0 → fit 算出 MIN_SCALE(8%)，
                //    用户看到的是"缩到最小的一片色块"。等 0.6s 让 fit 的动画跑完再读。
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    self.readJS("""
                    (function(){
                      var z = document.getElementById('zv');
                      var vp = window.__lcVp ? window.__lcVp() : -1;
                      return (z ? z.textContent : '?') + '|' + vp;
                    })()
                    """) { raw in
                        // #zv 显示的是取整后的百分比；__lcVp 是真实缩放
                        let parts = raw.components(separatedBy: "|")
                        let pct = Double((parts.first ?? "").replacingOccurrences(of: "%", with: "")) ?? -1
                        let vp = Double(parts.count > 1 ? parts[1] : "-1") ?? -1
                        self.expect(pct > 0 && pct >= 15,
                                    "第一次进画布：定位到当前焦点（缩放不是最小值 8%）",
                                    "zoom=\(pct)% raw=\(raw)")
                        self.expect(vp > 0,
                                    "画布视口有真实缩放（不是隐藏时算出来的 0）",
                                    "vp=\(vp) raw=\(raw)")
                        self.advance()
                    }
                }
            }
        }
    }

    /// 全新 origin 上第一件事是加密门禁，第二件事是新手引导。
    /// 两道都不跨过去，#app 还是 hidden，#main / #cv 根本不存在 ——
    /// 后面所有布局断言都无从谈起（第一版就是这么全线红着的）。
    private func dismissGates() {
        js("""
        var g = document.getElementById('gate');
        if (g && !g.hidden) document.getElementById('gateNoCrypto').click();
        window.__st = JSON.stringify({ ok: 1 });
        """)
        poll("跨过加密门禁", tries: 20) { [weak self] _ in
            guard let self else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                self.js("""
                var o = document.getElementById('onboard');
                if (o && !o.hidden) document.getElementById('onboardSkip').click();
                """)
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.verifyGates() }
            }
        }
    }

    private func verifyGates() {
        js("""
        var g = document.getElementById('gate'), o = document.getElementById('onboard');
        var a = document.getElementById('app');
        window.__st = JSON.stringify({
          gateHidden: !g || g.hidden,
          onboardHidden: !o || o.hidden,
          appHidden: !a || a.hidden,
          hasMain: !!document.querySelector('main'),
          hasCv: !!document.getElementById('cv')
        });
        """)
        poll("确认已进主界面") { [weak self] j in
            guard let self else { return }
            self.expect(self.b(j, "gateHidden"), "加密门禁已跨过", "gateHidden=\(self.b(j, "gateHidden"))")
            self.expect(self.b(j, "appHidden") == false, "#app 已显示", "appHidden=\(self.b(j, "appHidden"))")
            self.expect(self.b(j, "hasMain") && self.b(j, "hasCv"),
                        "#main / #cv 就位（布局断言的前提）",
                        "main=\(self.b(j, "hasMain")) cv=\(self.b(j, "hasCv"))")
            self.advance()
        }
    }

    private func advance() {
        guard step < steps.count else { done(); return }
        let next = steps[step]
        step += 1
        DispatchQueue.main.async { next() }
    }

    /// evaluateJavaScript 不 await Promise。统一约定：JS 同步把结果写进
    /// window.__st，Swift 侧轮询这个字段 —— 与 SmokeTest 同一套路。
    private func js(_ body: String) {
        webView.evaluateJavaScript("window.__st = undefined; (function(){\n\(body)\n})();") { _, err in
            if let err { self.fail("JS 异常", "\(err)") }
        }
    }

    private func poll(_ label: String, tries: Int = 40, then: @escaping ([String: Any]) -> Void) {
        check(0, label: label, tries: tries, then: then)
    }

    private func check(_ n: Int, label: String, tries: Int, then: @escaping ([String: Any]) -> Void) {
        guard n < tries else { fail(label, "40×300ms 超时"); return }
        webView.evaluateJavaScript("String(window.__st)") { res, _ in
            let v = (res as? String) ?? "undefined"
            if v != "undefined", !v.isEmpty {
                then(self.json(v))
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    self.check(n + 1, label: label, tries: tries, then: then)
                }
            }
        }
    }

    // MARK: - 步骤

    private func shellMode() {
        js("""
        var hdr = document.querySelector('header');
        window.__st = JSON.stringify({
          readyState: document.readyState,
          href: location.href,
          htmlHead: document.documentElement.outerHTML.slice(0, 500),
          nodeCount: document.getElementsByTagName('*').length,
          hasApp: !!document.getElementById('app'),
          bodyHead: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 160),
          nativeFlag: document.documentElement.dataset.nativeShell || '',
          headerDisplay: hdr ? getComputedStyle(hdr).display : 'NO_HEADER',
          headerRow: getComputedStyle(document.getElementById('app')).getPropertyValue('--hd').trim(),
          shellCmdInstalled: typeof window.__lcShell === 'object',
          segCount: document.querySelectorAll('#seg button').length
        });
        """)
        poll("web 顶栏让位") { [weak self] j in
            guard let self else { return }
            self.say("  ── 页面状态 ──")
            self.say("      readyState=\(self.s(j, "readyState"))  节点数=\(self.s(j, "nodeCount"))  #app=\(self.b(j, "hasApp"))")
            self.say("      location=\(self.s(j, "href"))")
            self.say("      HTML 前 500 字：\(self.s(j, "htmlHead", ""))")
            self.say("      正文前 160 字：\(self.s(j, "bodyHead", ""))")

            self.expect(self.controller.sawReady,
                        "web 发来了 ready", "sawReady=\(self.controller.sawReady)")
            self.expect(self.s(j, "nativeFlag", "") == "1",
                        "原生模式被识别（data-native-shell=1）", "nativeShell='\(self.s(j, "nativeFlag", ""))'")
            self.expect(self.s(j, "headerDisplay") == "none",
                        "web header 真的隐藏", "display=\(self.s(j, "headerDisplay"))")
            self.expect(self.s(j, "headerRow") == "0px",
                        "标题栏那条 52px 轨塌成 0（陷阱 3）", "--hd='\(self.s(j, "headerRow"))'")
            self.expect(self.b(j, "shellCmdInstalled"),
                        "原生→web 回调 window.__lcShell 已装", "typeof=\(self.s(j, "shellCmdInstalled"))")
            self.expect(self.d(j, "segCount") == 5,
                        "原生 5 段 segmented 与 web 的 5 个视图对齐", "web #seg 按钮数=\(self.s(j, "segCount"))")
            self.advance()
        }
    }

    /// 改窗口宽度 → 等 ResizeObserver + canvas.resize() → 读三列与画布尺寸
    private func resize(_ w: Int) -> () -> Void {
        return { [weak self] in
            guard let self else { return }
            if let win = self.controller.window {
                var f = win.frame
                f.size.width = CGFloat(w)
                f.size.height = 860
                win.setFrame(f, display: true)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.readLayout(w) }
        }
    }

    private func readLayout(_ w: Int) {
        js("""
        var app = document.getElementById('app');
        var lf  = document.getElementById('left'), rt = document.getElementById('right');
        var cv  = document.getElementById('cv');
        var ls  = getComputedStyle(lf), rs = getComputedStyle(rt);
        window.__st = JSON.stringify({
          cols: getComputedStyle(app).gridTemplateColumns,
          leftW: Math.round(lf.getBoundingClientRect().width),
          leftPos: ls.position,
          leftEdgeRight: Math.round(lf.getBoundingClientRect().right),
          leftTrack: getComputedStyle(app).gridTemplateColumns.split(' ')[0],
          tgLeft: getComputedStyle(document.getElementById('tgLeft')).display,
          rightW: Math.round(rt.getBoundingClientRect().width),
          rightPos: rs.position,
          rightEdgeLeft: Math.round(rt.getBoundingClientRect().left),
          tgRight: getComputedStyle(document.getElementById('tgRight')).display,
          innerW: window.innerWidth,
          mql980: window.matchMedia('(max-width: 980px)').matches,
          mql760: window.matchMedia('(max-width: 760px)').matches,
          htmlData: Object.keys(document.documentElement.dataset).join(','),
          leftTf: getComputedStyle(lf).transform,
          tgLeftAttrHidden: document.getElementById('tgLeft').hidden,
          canvasCss: cv.clientWidth + 'x' + cv.clientHeight,
          canvasBacking: cv.width + 'x' + cv.height,
          dpr: window.devicePixelRatio,
          mainW: Math.round(document.querySelector('main').getBoundingClientRect().width)
        });
        """)
        poll("断点 \(w)px") { [weak self] j in
            guard let self else { return }
            let css  = s(j, "canvasCss").split(separator: "x")
            let back = s(j, "canvasBacking").split(separator: "x")
            let dpr  = d(j, "dpr", 2)
            // 后备存储必须正好 = CSS 尺寸 × DPR。不等 = 画布没随栅格重算，会糊/拉伸
            var crisp = false
            if css.count == 2, back.count == 2 {
                crisp = abs(Double(css[0])! * dpr - Double(back[0])!) < 1.5
                     && abs(Double(css[1])! * dpr - Double(back[1])!) < 1.5
            }

            self.say("  ── 窗口 \(w)px ──")
            self.say("      cols      \(s(j, "cols"))")
            self.say("      left      \(s(j, "leftW"))px  track=\(s(j, "leftTrack"))  position=\(s(j, "leftPos"))  收起后右缘=\(s(j, "leftEdgeRight"))  tg=\(s(j, "tgLeft"))")
            self.say("      right     \(s(j, "rightW"))px  position=\(s(j, "rightPos"))  收起后左缘=\(s(j, "rightEdgeLeft"))  tg=\(s(j, "tgRight"))")
            self.say("      canvas    css=\(s(j, "canvasCss"))  backing=\(s(j, "canvasBacking"))  dpr=\(s(j, "dpr"))")
            self.say("      mql980=\(self.b(j, "mql980"))  mql760=\(self.b(j, "mql760"))  innerW=\(self.s(j, "innerW"))")
            self.say("      <html data-*>=[\(self.s(j, "htmlData", ""))]  left transform=\(self.s(j, "leftTf"))")
            self.say("      tgLeft[hidden] 属性=\(self.b(j, "tgLeftAttrHidden"))")

            self.expect(crisp,
                        "\(w)px 画布后备存储 = CSS×DPR（ResizeObserver 生效）",
                        "css=\(s(j, "canvasCss")) ×dpr=\(s(j, "dpr")) vs backing=\(s(j, "canvasBacking"))")

            let leftW = d(j, "leftW"), rightW = d(j, "rightW")
            switch w {
            case 1440:
                self.expect(leftW > 200 && rightW > 300, "1440px 两栏都在栅格里展开",
                            "left=\(leftW) right=\(rightW)")
            case 1100:
                self.expect(leftW > 150 && leftW < 250, "1100px 左栏收窄进 216 档", "left=\(leftW)")
            case 900:
                // 抽屉靠 translateX 滑出屏外，宽度保留、轨道才是 0。
                // 断言"右缘 ≤ 1"而不是"宽度 = 0" —— 后者对 transform 方案是错的。
                self.expect(self.s(j, "leftPos") == "absolute" && self.s(j, "leftTrack") == "0px",
                            "900px 左栏脱离栅格，轨道让位给画布",
                            "track=\(self.s(j, "leftTrack")) position=\(self.s(j, "leftPos"))")
                self.expect(self.d(j, "leftEdgeRight") <= 1,
                            "900px 左栏收起到屏外（transform 滑走）",
                            "收起后右缘=\(self.s(j, "leftEdgeRight")) 宽仍=\(leftW)")
                self.expect(self.s(j, "tgLeft") != "none", "900px 出现左栏开关", "tgLeft display=\(self.s(j, "tgLeft"))")
                self.expect(rightW > 200 && self.s(j, "rightPos") == "static",
                            "900px 右栏仍留在栅格里", "right=\(rightW) position=\(self.s(j, "rightPos"))")
            default:
                self.expect(self.s(j, "rightPos") == "absolute",
                            "700px 右栏脱离栅格", "position=\(self.s(j, "rightPos"))")
                self.expect(self.d(j, "rightEdgeLeft") >= self.d(j, "innerW") - 1,
                            "700px 右栏收起到屏外",
                            "收起后左缘=\(self.s(j, "rightEdgeLeft")) 窗口宽=\(self.s(j, "innerW"))")
                self.expect(self.s(j, "tgRight") != "none", "700px 出现右栏开关", "tgRight display=\(self.s(j, "tgRight"))")
            }
            self.advance()
        }
    }

    /// 原生点 segmented → web 真的切了视图；再由 web 回执校正原生那一段。
    /// 两条通道分别断言：native→web 看 DOM 效果，web→native 看 Bridge.receivedTypes。
    private func nativeToWebView() {
        let before = controller.bridge.receivedTypes
        controller.selectView(2)   // 时间轴
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self else { return }
            self.js("""
            var ids = ['today','canvas','tl','lv','wk'];
            var shown = ids.filter(function(v){
              var e = document.getElementById('v' + v.charAt(0).toUpperCase() + v.slice(1));
              return e && !e.hidden;
            });
            window.__st = JSON.stringify({ shown: shown });
            """)
            self.poll("原生切视图") { [weak self] j in
                guard let self else { return }
                let shown = self.arr(j, "shown")
                self.expect(shown == ["tl"],
                            "点原生 segmented → web 切到时间轴", "可见视图=\(shown)")
                let after = self.controller.bridge.receivedTypes
                let fresh = after.count > before.count
                    ? Array(after[before.count...]) : []
                self.expect(fresh.contains("viewChanged"),
                            "web 回执 viewChanged（原生 segmented 不会跟真实值走偏）",
                            "本步收到=\(fresh)")
                self.advance()
            }
        }
    }

    private func nativeToWebSearch() {
        let before = controller.bridge.receivedTypes
        controller.bridge.send("search", ["q": "测试"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            guard let self else { return }
            self.js("""
            window.__st = JSON.stringify({
              q: document.getElementById('q').value,
              qcnt: document.getElementById('qcnt').textContent
            });
            """)
            self.poll("原生搜索框") { [weak self] j in
                guard let self else { return }
                self.expect(self.s(j, "q", "") == "测试",
                            "原生搜索 → web 的 #q 收到", "q='\(self.s(j, "q", ""))'")
                let after = self.controller.bridge.receivedTypes
                let fresh = after.count > before.count
                    ? Array(after[before.count...]) : []
                self.expect(fresh.contains("searchChanged"),
                            "web 回执 searchChanged（命中数能上工具栏）",
                            "本步收到=\(fresh)  #qcnt='\(self.s(j, "qcnt", ""))'")
                self.advance()
            }
        }
    }

    /// 空间隔离 —— 周画布的地基。
    ///
    /// 四条断言，盯的都是同一件事：**切空间会不会动到用户的东西**。
    ///   1. 切到周空间，主画布的点一个都不该漏进来
    ///   2. 周空间里造的点，在周空间里看得到
    ///   3. 来回切 100 次之后，主画布的坐标必须一字未动
    ///   4. 自测造的临时点必须清理干净
    ///
    /// ⚠️ 自测跑在**用户真实数据**上 —— 这里造的点删不干净就是往用户库里留垃圾，
    ///    所以清理那一步不能省，也不能只删一半。
    private func spaceIsolation() {
        js("""
        var WK = 'week:2026-11-02';
        var mainIds = window.__lcNodeIds();
        var mainPos = window.__lcNodePositions();
        // 在周空间造一个点
        var made = window.__lcMakeNode('空间自测临时点', WK);
        // 切到周空间
        window.__lcSetSpace(WK);
        var weekIds = window.__lcSpaceNodeIds();
        // 主画布的点不该出现在周空间里
        var leaked = weekIds.filter(function(id){ return mainIds.indexOf(id) >= 0; });
        var hasMade = weekIds.indexOf(made) >= 0;
        // 来回切 100 次
        for (var i = 0; i < 100; i++) {
          window.__lcSetSpace(i % 2 === 0 ? WK : 'default');
        }
        window.__lcSetSpace('default');
        var afterPos = window.__lcNodePositions();
        var moved = [];
        for (var id in mainPos) {
          if (mainPos[id] !== (afterPos[id] || '')) moved.push(id);
        }
        // 清理：删掉临时点
        window.__lcDeleteNode(made);
        window.__lcSetSpace('default');
        window.__st = JSON.stringify({
          mainCount: mainIds.length,
          weekCount: weekIds.length,
          leaked: leaked.length,
          hasMade: hasMade,
          moved: moved.length,
          stillThere: window.__lcSpaceNodeCount(WK)
        });
        """)
        poll("空间隔离") { [weak self] j in
            guard let self else { return }
            self.expect(self.d(j, "leaked") == 0,
                        "切到周空间，主画布的点一个都没漏进来",
                        "主画布=\(self.d(j, "mainCount")) 个点，漏进来=\(self.d(j, "leaked")) 个")
            self.expect(self.b(j, "hasMade"),
                        "周空间里的点，在周空间里看得到",
                        "周空间=\(self.d(j, "weekCount")) 个点")
            self.expect(self.d(j, "moved") == 0,
                        "来回切 100 次空间，主画布坐标一字未动",
                        "动了=\(self.d(j, "moved")) 个点")
            self.expect(self.d(j, "stillThere") == 0,
                        "自测造的临时点已清理干净",
                        "周空间还剩=\(self.d(j, "stillThere")) 个点")
            self.advance()
        }
    }

    /// 阶段三：引入本周原数据 —— 副本真的落在周空间、记得回原文、原件不动。
    ///
    /// 盯的是「引入」这条路的**语义**，不是它的界面：
    ///   1. 引入产生的是**副本**，不是搬家
    ///   2. 副本记得自己是从哪儿复制来的（sourceId ⇒ 能回原文）
    ///   3. 副本落在周空间，原件留在主画布
    ///
    /// ⚠️ 自测跑在**用户真实数据**上 —— 这里自己造原件（主空间里的临时点），
    ///    引入，再把副本和原件**都按 id 精确删掉**。不能拿用户自己的点来测。
    private func weekImport() {
        js("""
        var WK = 'week:2026-06-01';
        var mainBefore = window.__lcSpaceNodeCount('default');
        // 造一个原件：主空间里、日期落在 2026-06-01 那一周
        var orig = window.__lcMakeNode('引入自测临时原件', 'default', '2026-06-03', 'idea', []);
        // 引入（和 UI 走同一套逻辑）
        var copies = window.__lcImportWeek('2026-06-01', [orig]);
        var copy = copies[0] || '';
        var src = copy ? window.__lcNodeSource(copy) : '';
        var copySpace = copy ? window.__lcNodeSpace(copy) : '';
        var origSpace = window.__lcNodeSpace(orig);
        // 切到周空间：副本在，原件不该在
        window.__lcSetSpace(WK);
        var weekIds = window.__lcSpaceNodeIds();
        var copyInWeek = weekIds.indexOf(copy) >= 0;
        var origInWeek = weekIds.indexOf(orig) >= 0;
        // 切回主画布：原件还在，副本不该在
        window.__lcSetSpace('default');
        var mainIds = window.__lcSpaceNodeIds();
        var origInMain = mainIds.indexOf(orig) >= 0;
        var copyInMain = mainIds.indexOf(copy) >= 0;
        // 清理：副本 + 原件都删掉（按 id 精确删）
        if (copy) window.__lcDeleteNode(copy);
        window.__lcDeleteNode(orig);
        window.__lcSetSpace('default');
        window.__st = JSON.stringify({
          made: copies.length,
          orig: orig,
          src: src,
          copySpace: copySpace,
          origSpace: origSpace,
          copyInWeek: copyInWeek,
          origInWeek: origInWeek,
          origInMain: origInMain,
          copyInMain: copyInMain,
          leftWeek: window.__lcSpaceNodeCount(WK),
          leftMain: window.__lcSpaceNodeCount('default'),
          mainBefore: mainBefore
        });
        """)
        poll("引入原数据") { [weak self] j in
            guard let self else { return }
            self.expect(self.d(j, "made") == 1,
                        "引入本周原数据生成了 1 个副本", "made=\(self.d(j, "made"))")
            self.expect(self.s(j, "src", "") == self.s(j, "orig", ""),
                        "副本记得自己是从哪儿复制来的（能回原文）",
                        "sourceId=\(self.s(j, "src", "")) 原件=\(self.s(j, "orig", ""))")
            self.expect(self.s(j, "copySpace", "") == "week:2026-06-01",
                        "副本落在周画布里", "copySpace=\(self.s(j, "copySpace", ""))")
            self.expect(self.s(j, "origSpace", "") == "default" && self.b(j, "origInMain"),
                        "原件留在主画布，没被搬走",
                        "origSpace=\(self.s(j, "origSpace", "")) origInMain=\(self.b(j, "origInMain"))")
            self.expect(self.b(j, "copyInWeek") && !self.b(j, "origInWeek"),
                        "周画布里看得见副本，看不见原件",
                        "copyInWeek=\(self.b(j, "copyInWeek")) origInWeek=\(self.b(j, "origInWeek"))")
            self.expect(!self.b(j, "copyInMain"),
                        "主画布里没有副本（复制，不是搬家）",
                        "copyInMain=\(self.b(j, "copyInMain"))")
            self.expect(self.d(j, "leftWeek") == 0 && self.d(j, "leftMain") == self.d(j, "mainBefore"),
                        "自测造的原件和副本都清理干净了",
                        "周空间剩=\(self.d(j, "leftWeek")) 主画布=\(self.d(j, "leftMain"))（自测前 \(self.d(j, "mainBefore"))）")
            self.advance()
        }
    }

    /// 阶段四：图卡（作品 + 图 ⇒ 图片铺满整块）+ 缩放手柄。
    ///
    /// 验三件事：
    ///   1. 图卡**真的把图画满了整块**（数洋红像素的占比，不只是"有图"）
    ///   2. 抓住右下角的手柄能改节点大小
    ///   3. 拖到比最小尺寸还小 ⇒ 被夹住（不会缩成一条线）
    ///
    /// ⚠️ 自测跑在**用户真实数据**上 —— 这里自己造一个图卡，测完按 id 精确删掉。
    /// ⚠️ 必须先清焦点：焦点在某个主题上时，不属于它的点**根本不画**
    ///    （visibleNodesByFocus 过滤）—— 不清焦点，"图画出来了"这条恒假。
    private func imageCard() {
        // ⚠️ 必须切到画布视图：画布**隐藏**时 getBoundingClientRect() 是 0×0 ——
        //    画布压根不渲染 ⇒ "图画出来了"恒假，拖手柄也拖不动。
        //    （前面 nativeToWebWeekView 为了保持后续步骤的前提切回了时间轴）
        controller.selectView(1)   // views: today / canvas / tl / lv / wk
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            guard let self else { return }
            self.js("""
        (function(){
          // 洋红：画布配色里没有洋红 ⇒ 数到洋红 = 这张图真的画上去了
          var c = document.createElement('canvas'); c.width = 400; c.height = 300;
          var g = c.getContext('2d');
          g.fillStyle = '#ff00ff'; g.fillRect(0, 0, 400, 300);
          var data = c.toDataURL('image/png');
          // ⚠️ 必须先清"看东西的状态"（焦点 / 筛选 / 搜索 / 选中）：
          //    画布只画**看得见**的点 —— 焦点外的、筛选外的、没命中的统统不画。
          //    前面 nativeToWebSearch 在搜索框里留了词，于是这张临时图卡
          //    压根没被画过 ⇒ "图画出来了"恒假、拖手柄也像失灵。
          window.__lcResetView();
          var id = window.__lcMakeImageCard('自测临时图卡', data, {x: 8000, y: 8000, w: 300, h: 220});
          // ⚠️ 摆在很远的地方：点的判定是"边优先"，
          //    边上正好有条连线的话，按手柄会被当成点线。
          window.__lcCenterOn(id, 1);
          window.__lcSelect(id);
          var tries = 0;
          var timer = setInterval(function(){
            tries++;
            if (!window.__lcImageReady(id)) {
              if (tries > 60) { clearInterval(timer); window.__st = JSON.stringify({ok:0, why:'图没解开'}); }
              return;
            }
            // 图解开了，还要等画布重画完 —— 解码兑现的那一刻画布未必已经重画
            setTimeout(function(){
              clearInterval(timer);
              var box = window.__lcNodeBox(id);
              var magenta = window.__lcNodeColorCount(id, 255, 0, 255, 70);
              window.__st = JSON.stringify({
                ok: 1, id: id, magenta: magenta,
                area: box ? box.area : 0,
                view: window.__lcView ? window.__lcView() : {}
              });
            }, 600);
          }, 150);
        })()
        """)
        self.poll("图卡已就位") { [weak self] j in
            guard let self else { return }
            guard self.b(j, "ok") else {
                self.fail("图卡就位", self.s(j, "why", "?"))
                self.advance()
                return
            }
            let id = self.s(j, "id", "")
            let magenta = self.d(j, "magenta")
            let area = self.d(j, "area")
            let pct = area > 0 ? magenta / area : 0
            self.expect(magenta > 2000,
                        "图卡把图画出来了（洋红像素数）",
                        "magenta=\(magenta)")
            self.expect(pct > 0.5,
                        "图是**铺满整块**的（占节点面积一半以上），不是缩略图",
                        "占比=\(Int(pct * 100))%（\(magenta)/\(area)）")
            // 抓住右下角的手柄往右下拖
            self.js("""
            (function(){
              var id = '\(id)';
              var cv = document.getElementById('cv');
              // 拖之前**重新选中**：这一步不该依赖几秒前设的选中状态
              window.__lcSelect(id);
              var box = window.__lcNodeBox(id);
              if (!box) { window.__st = JSON.stringify({ok:0, why:'no box'}); return; }
              var beforeW = box.w, beforeH = box.h;
              function ev(type, x, y, target) {
                (target||cv).dispatchEvent(new MouseEvent(type, {clientX:x, clientY:y, bubbles:true, buttons:1}));
              }
              var sel0 = window.__lcView().selected;
              var hit0 = window.__lcResizeHandleAt(box.handleX, box.handleY);
              var inIdx = window.__lcIndexHas ? window.__lcIndexHas(id) : 'nohook';
              ev('mousedown', box.handleX, box.handleY);
              var sel1 = window.__lcView().selected;
              window.dispatchEvent(new MouseEvent('mousemove', {clientX: box.handleX + 90, clientY: box.handleY + 70, bubbles:true, buttons:1}));
              var grown = window.__lcNodeBox(id);
              // 再往左上拖到极小 ⇒ 应该被夹住
              ev('mousedown', grown.handleX, grown.handleY);
              window.dispatchEvent(new MouseEvent('mousemove', {clientX: grown.handleX - 9999, clientY: grown.handleY - 9999, bubbles:true, buttons:1}));
              window.dispatchEvent(new MouseEvent('mouseup', {clientX: grown.handleX - 9999, clientY: grown.handleY - 9999, bubbles:true, buttons:1}));
              var shrunk = window.__lcNodeBox(id);
              var cvr = cv.getBoundingClientRect();
              window.__st = JSON.stringify({
                ok:1, beforeW:beforeW, beforeH:beforeH,
                grownW:grown.w, grownH:grown.h,
                shrunkW:shrunk.w, shrunkH:shrunk.h,
                hit0: hit0, sel0: sel0, sel1: sel1, inIdx: inIdx,
                selEnd: window.__lcView().selected,
                handleX: box.handleX, handleY: box.handleY,
                rectL: cvr.left, rectT: cvr.top, rectW: cvr.width, rectH: cvr.height
              });
            })()
            """)
            self.poll("缩放手柄") { [weak self] j2 in
                guard let self else { return }
                self.expect(self.d(j2, "grownW") > self.d(j2, "beforeW"),
                            "拖右下角的手柄 ⇒ 节点变大了（图卡能拉多大多大）",
                            "\(self.d(j2, "beforeW")) → \(self.d(j2, "grownW"))"
                            + " 按前命中=[\(self.s(j2, "hit0", "?"))] 选中=\(self.d(j2, "sel0"))"
                            + " 按后选中=\(self.d(j2, "sel1")) 索引里有=\(self.s(j2, "inIdx", "?"))"
                            + " 结束选中=\(self.d(j2, "selEnd"))"
                            + " 手柄=(\(self.d(j2, "handleX")),\(self.d(j2, "handleY")))"
                            + " 画布=(\(self.d(j2, "rectL")),\(self.d(j2, "rectT")) \(self.d(j2, "rectW"))×\(self.d(j2, "rectH")))")
                self.expect(self.d(j2, "shrunkW") >= 120 && self.d(j2, "shrunkH") >= 56,
                            "拖到比最小尺寸还小 ⇒ 被夹住（不会缩成一条线）",
                            "w=\(self.d(j2, "shrunkW")) h=\(self.d(j2, "shrunkH"))（下限 120×56）")
                // 清理：按 id 精确删掉临时图卡。
                // ⚠️ 不还原焦点/搜索 —— 这一步开头调了 __lcResetView（把"看"的状态全清了），
                //    而后面的 nativeResetCanvas 本来也会重置一次；数据一个字节都没动。
                self.js("""
                window.__lcDeleteNode('\(id)');
                window.__st = JSON.stringify({ok:1});
                """)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    // 切回时间轴，保持后续步骤的视图前提（跟 nativeToWebWeekView 一样）
                    self.controller.selectView(2)
                    self.advance()
                }
            }
        }
        }
    }

    /// 阶段五：复盘卡片（1080×1440 PNG）。
    ///
    /// 验三件事：
    ///   1. 卡片尺寸是 1080×1440（后备存储 2160×2880）
    ///   2. **导得出去** —— toDataURL 不抛 SecurityError
    ///      （外链图必须先转 dataURL，否则 canvas 被污染，整张卡导不出来）
    ///   3. ★ 卡片上的每一个字都是**用户自己写的** —— 每一行都必须能在
    ///      某个点的标题/正文里原样找到（软件不生成总结文字）
    private func reviewCard() {
        js("""
        (function(){
          var WK = 'week:2026-06-01';
          window.__lcSetSpace(WK);
          var a = window.__lcMakeNode('卡片自测临时甲', WK, '2026-06-02', 'idea', []);
          var b = window.__lcMakeNode('卡片自测临时乙', WK, '2026-06-04', 'reflect', []);
          window.__st = JSON.stringify({ ok: 1, a: a, b: b });
        })()
        """)
        poll("复盘卡片数据已就位") { [weak self] j in
            guard let self else { return }
            let a = self.s(j, "a", "")
            let b = self.s(j, "b", "")
            self.js("""
            (function(){
              window.__lcReviewCard().then(function(r){
                window.__st = JSON.stringify(r);
              }).catch(function(e){
                window.__st = JSON.stringify({ok:0, why:String(e)});
              });
            })()
            """)
            self.poll("复盘卡片已渲染") { [weak self] j2 in
                guard let self else { return }
                self.expect(self.d(j2, "w") == 2160 && self.d(j2, "h") == 2880,
                            "复盘卡片是 1080×1440（2 倍后备存储）",
                            "\(self.d(j2, "w"))×\(self.d(j2, "h"))")
                self.expect(self.s(j2, "png", "").hasPrefix("data:image/png"),
                            "卡片导得出去（toDataURL 没抛 SecurityError）",
                            self.s(j2, "png", "?"))
                // ★ 硬约束：卡片上的正文每一行都是用户原文的片段
                let lines = self.arr(j2, "lines")
                let titles = self.arr(j2, "titles")
                let contents = self.arr(j2, "contents")
                let source = (titles + contents).joined(separator: "\n")
                let stray = lines.filter { line in
                    if line.isEmpty { return false }
                    return !source.contains(line)
                }
                self.expect(stray.isEmpty,
                            "★ 卡片上的正文都是用户自己写的（没有软件生成的总结）",
                            stray.isEmpty
                                ? "共 \(lines.count) 行，逐行都能在原文里找到"
                                : "这些行不是原文：\(stray.prefix(3).joined(separator: " / "))")
                // 小字行只能是「类型 · 时间」—— 事实，不是生成的文字
                let meta = self.arr(j2, "metaLines")
                let metaOK = meta.allSatisfy { m in
                    m.range(of: "^(目标|事件|情绪|想法|人物|资源|行动|反思|地点|作品)( · .+)?$",
                            options: .regularExpression) != nil
                }
                self.expect(metaOK,
                            "小字行只有「类型 · 时间」（事实，不是生成的文字）",
                            meta.isEmpty ? "（这周没有点）" : meta.joined(separator: " / "))
                // 清理
                self.js("""
                window.__lcDeleteNode('\(a)');
                window.__lcDeleteNode('\(b)');
                window.__lcSetSpace('default');
                window.__st = JSON.stringify({ok:1});
                """)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.advance()
                }
            }
        }
    }

    /// 原生 segmented 的第 5 段 → web 切到周历。
    ///
    /// 周历是周画布的入口，必须能从原生工具栏点进去 ——
    /// 少接这一段，网页上能看周历、桌面版却找不到。
    /// 测完切回时间轴，保持后续步骤的视图前提不变。
    private func nativeToWebWeekView() {
        controller.selectView(4)   // views: today / canvas / tl / lv / wk
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            guard let self else { return }
            self.js("""
            var ids = ['today','canvas','tl','lv','wk'];
            var shown = ids.filter(function(v){
              var e = document.getElementById('v' + v.charAt(0).toUpperCase() + v.slice(1));
              return e && !e.hidden;
            });
            var rows = document.querySelectorAll('#vWk .wk-row[data-monday]').length;
            var on = document.querySelector('#seg button.on');
            window.__st = JSON.stringify({
              shown: shown,
              rows: rows,
              segOn: on ? on.dataset.v : ''
            });
            """)
            self.poll("原生切到周历") { [weak self] j in
                guard let self else { return }
                let shown = self.arr(j, "shown")
                self.expect(shown == ["wk"],
                            "点原生 segmented 第 5 段 → web 切到周历", "可见视图=\(shown)")
                self.expect(self.d(j, "rows") > 0,
                            "周历渲染出了周行", "周行数=\(self.d(j, "rows"))")
                self.expect(self.s(j, "segOn", "") == "wk",
                            "web 这边的分段高亮也跟着是周历", "segOn=\(self.s(j, "segOn", ""))")
                // 切回时间轴，保持后续步骤的视图前提
                self.controller.selectView(2)
                self.advance()
            }
        }
    }

    /// 原生菜单「人生画布 → 设置…」→ web 打开设置面板。
    ///
    /// ⚠️ 为什么这条断言不能省：
    ///    原生模式下 web 顶栏被隐藏（--hd 归零），「设置」只剩菜单栏一个入口；
    ///    而「导入 JSON」原来**藏在「导出」菜单里**（菜单叫导出、里面塞导入），
    ///    那个菜单在原生模式下也没了 —— 于是「设置」和「导入」一起消失，
    ///    而且**不报任何错**，只剩"用户找不到"（2026-10-23 用户反馈）。
    ///    这条断言盯的就是「面板能开 + 面板里有导入/导出入口」。
    private func nativeSettingsOpensPanel() {
        // 走真实的原生动作通道（菜单项就是发这个）
        controller.bridge.send("action", ["action": "settings"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            guard let self else { return }
            self.js("""
            var m = document.getElementById('modal');
            var c = document.getElementById('modalCard');
            var t = c ? c.innerText : '';
            window.__st = JSON.stringify({
              modalHidden: m ? m.hidden : true,
              modalDisplay: m ? getComputedStyle(m).display : 'none',
              hasSettings: t.includes('设置'),
              hasImport: t.includes('导入'),
              hasExport: t.includes('导出')
            });
            """)
            self.poll("设置面板") { [weak self] j in
                guard let self else { return }
                self.expect(self.b(j, "modalHidden") == false,
                            "原生「设置…」→ web 设置面板打开", "hidden=\(self.s(j, "modalHidden"))")
                self.expect(self.b(j, "hasSettings"),
                            "弹出来的是设置面板", "hasSettings=\(self.s(j, "hasSettings"))")
                self.expect(self.b(j, "hasImport"),
                            "设置面板里有导入入口", "hasImport=\(self.s(j, "hasImport"))")
                self.expect(self.b(j, "hasExport"),
                            "设置面板里有导出入口", "hasExport=\(self.s(j, "hasExport"))")
                // 收尾：关掉面板，别影响后续步骤
                self.js("var m = document.getElementById('modal'); if (m) m.hidden = true; window.__st = '1';")
                self.advance()
            }
        }
    }

    /// 原生菜单「视图 → 重置画布」→ web 侧的"看"状态全清，**数据一个不动**。
    ///
    /// ⚠️ 为什么这条不能省：
    ///    原生模式 web 顶栏整个被隐藏，重置按钮**只在画布浮层里**。
    ///    菜单项走的是 action 通道（web 侧 runAction → 点 #zReset）——
    ///    这条链一旦对不上（比如 action 名写错、选择器写错），
    ///    原生点菜单**什么都不会发生**，而且不报错。
    ///    断言要读 web 的**实际状态**（__lcView），不是读界面元素。
    private func nativeResetCanvas() {
        // ⚠️ 先造一份数据：自测跑在用户真实库上，可能是空的。
        //    空库时"焦点清没清""选中的点清没清"恒真（本来就没东西可清），
        //    等于没测到。测完会把用户原库还回去（不留在用户库里）。
        //
        // ⚠️ 用 Promise 完成信号来等，不靠"睡 N 秒"：
        //    evaluateJavaScript 不 await Promise，所以让 Promise 完成时
        //    再写 __st，poll 等的就是"真的准备好了"这个信号。
        self.js("""
        (function(){
          // ⚠️ 先记下**用户原库**的量 —— 换示例数据之后就读不到了。
          //    收尾要比的是"还原后 == 用户原库"，不是"还原后 == 示例数据"：
          //    用户原库可能是空的（0 个点），拿示例数据的量去比会误判成"还原失败"。
          window.__lcOrigNodes = window.__lcState ? window.__lcState().nodes : -1;
          var p = window.__lcLoadSample ? window.__lcLoadSample() : Promise.resolve(0);
          Promise.resolve(p).then(function(){
            window.__st = JSON.stringify({
              nodes: window.__lcState ? window.__lcState().nodes : -1,
              origNodes: window.__lcOrigNodes
            });
          });
        })()
        """)
        self.poll("备好自测数据") { [weak self] j in
            guard let self else { return }
            self.expect(self.d(j, "nodes") > 0,
                        "自测数据已就绪（有东西可弄脏、也有东西可验）",
                        "nodes=\(self.d(j, "nodes"))")
            // 用户原库的量：收尾要拿它来比对
            let origNodes = Int(self.d(j, "origNodes"))
            // 先把画布弄脏：设焦点 + 搜索 + 选中一个点
            self.js("""
            (function(){
              if (!window.__lcView) { window.__st = JSON.stringify({ ok: 0, why: 'no __lcView hook' }); return; }
              var t = document.querySelector('#treeTheme .tnode');
              if (t) t.click();
              var q = document.getElementById('q');
              if (q) { q.value = '测试'; q.dispatchEvent(new Event('input', {bubbles:true})); }
              var ids = window.__lcNodeIds ? window.__lcNodeIds() : [];
              if (ids.length && window.__lcSelect) window.__lcSelect(ids[0]);
              window.__st = JSON.stringify({ ok: 1 });
            })()
            """)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                guard let self else { return }
                // ⚠️ js() 每次都先把 __st 置 undefined，所以这一步要把"脏状态"和
                //    "重置前的数据量"**一起**写进同一个 __st —— 分两次写，
                //    后一次会把前一次冲掉（症状：断言读到 undefined，恒假）。
                self.js("""
                (function(){
                  var v = window.__lcView ? window.__lcView() : {};
                  var s = window.__lcState ? window.__lcState() : {};
                  window.__st = JSON.stringify({
                    ok: 1,
                    dirtyTheme: v.themeId != null,
                    dirtyStage: v.stageId != null,
                    dirtyQuery: (v.query || '') !== '',
                    dirtySelected: (v.selected || 0) > 0,
                    nodesBefore: s.nodes || 0,
                    view: v
                  });
                })()
                """)
                self.poll("重置前的脏状态") { [weak self] j in
                    guard let self else { return }
                    self.expect(self.b(j, "ok"),
                                "重置前的状态可读（__lcView 钩子在）",
                                "view=\(self.s(j, "view", "?"))")
                    // ⚠️ 空库时没有主题/阶段可选 —— 那时焦点本来就是 null，
                    //    断言"焦点非空"会恒假。改成：**有数据才要求脏**。
                    //    这条断言防的是"重置压根没触发，脏状态原样留着"。
                    let nodesBefore = Int(self.d(j, "nodesBefore"))
                    self.expect(nodesBefore > 0,
                                "自测已备好数据（焦点/选中才有东西可验）",
                                "nodes=\(nodesBefore)")
                    if nodesBefore > 0 {
                        self.expect(self.b(j, "dirtyTheme") || self.b(j, "dirtyStage"),
                                    "重置前：焦点确实设上了",
                                    "theme=\(self.b(j, "dirtyTheme")) stage=\(self.b(j, "dirtyStage"))")
                        self.expect(self.b(j, "dirtySelected"),
                                    "重置前：确实选中了点",
                                    "selected=\(self.b(j, "dirtySelected"))")
                    }
                    self.expect(self.b(j, "dirtyQuery"),
                                "重置前：搜索词确实输入了",
                                "query=\(self.b(j, "dirtyQuery"))")
                    // 走真实的原生动作通道（菜单项就是发这个）
                    controller.bridge.send("action", ["action": "reset"])
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                        guard let self else { return }
                        self.js("""
                        window.__st = JSON.stringify({
                          view: window.__lcView(),
                          state: window.__lcState(),
                          q: document.getElementById('q').value
                        });
                        """)
                    self.poll("原生重置画布") { [weak self] j in
                        guard let self else { return }
                        let view = j["view"] as? [String: Any] ?? [:]
                        let state = j["state"] as? [String: Any] ?? [:]
                        self.expect(view["themeId"] is NSNull || view["themeId"] == nil,
                                    "原生「重置画布」→ 主题焦点清空",
                                    "themeId=\(view["themeId"] ?? "nil")")
                        self.expect(view["stageId"] is NSNull || view["stageId"] == nil,
                                    "阶段焦点清空",
                                    "stageId=\(view["stageId"] ?? "nil")")
                        self.expect(self.s(j, "q", "?") == "",
                                    "搜索框清空",
                                    "q='\(self.s(j, "q", ""))'")
                        self.expect((view["selected"] as? Int ?? -1) == 0,
                                    "选中的点清空",
                                    "selected=\(view["selected"] ?? -1)")
                        self.expect((view["query"] as? String ?? "?") == "",
                                    "搜索词清空",
                                    "query='\(view["query"] ?? "?")'")
                        self.expect((view["filterActive"] as? Bool ?? true) == false,
                                    "筛选清空",
                                    "filterActive=\(view["filterActive"] ?? "?")")
                        // 数据不动 —— 重置的硬要求。
                        // ⚠️ 比的是**重置前后的数量**，不是"库里有点"：
                        //    空库时 nodes=0，重置后还是 0，"数据没被动过"照样成立。
                        //    nodesBefore 用上面闭包捕获的值 —— 它写在**上一次**的
                        //    __st 里，而这一次 js() 已经把 __st 覆盖掉了，
                        //    从当前 JSON 里读永远是 -1。
                        let nodes = state["nodes"] as? Int ?? -1
                        self.expect(nodes == nodesBefore,
                                    "数据一个没动（重置只清状态，不删记录）",
                                    "重置前=\(nodesBefore) 重置后=\(nodes)")
                        // 收尾：把**用户原库**还回去。
                        // ⚠️ 必须还：自测跑在**用户真实数据**上，
                        //    为了让断言有东西可验，自测临时换成了示例空间 ——
                        //    不还回去就是拿用户的数据换示例数据（不可逆的破坏）。
                        //
                        // ⚠️ ⚠️ 为什么要用 .then 写 __st：
                        //    evaluateJavaScript **不 await Promise**，
                        //    而且 js() 每次都先把 __st 置 undefined。
                        //    所以直接在后面写 __st='1' 的话，poll 会读到
                        //    "还没还原完"的中间状态（实测 nodes=0）——
                        //    看着像还原失败，其实是断言问早了。
                        //    让 Promise 完成后再写 __st，poll 才等得到真正的结果。
                        self.js("""
                        (function(){
                          var p = window.__lcRestoreData ? window.__lcRestoreData() : Promise.resolve(0);
                          Promise.resolve(p).then(function(){
                            window.__st = JSON.stringify({
                              nodes: window.__lcState ? window.__lcState().nodes : -1
                            });
                          });
                        })()
                        """)
                        self.poll("还原用户数据") { [weak self] j in
                            guard let self else { return }
                            // ⚠️ 比的是**用户原库**的量，不是示例数据的量：
                            //    用户原库可能是空的（0 个点），
                            //    拿示例数据的 29 去比会误判成"还原失败"。
                            self.expect(self.d(j, "nodes") == Double(origNodes),
                                        "自测数据已还原（用户原库没被动过）",
                                        "还原后 nodes=\(self.d(j, "nodes"))，用户原库=\(origNodes)")
                            self.advance()
                        }
                        }
                    }
                }
            }
        }
    }

    /// 点「导入」→ 原生**确实收到了文件面板请求**。
    ///
    /// ⚠️ 为什么这条不能省：
    ///    WKWebView 里 <input type="file"> 和 <a download> 都要靠
    ///    WKUIDelegate.runOpenPanelWith 才会落地。**不接的话 WebKit 静默丢弃**，
    ///    点「选择 JSON 文件…」什么都不会发生 —— 不报错、不弹面板，
    ///    而 web 那边已经把设置面板关掉了，用户就"莫名其妙回到画布"。
    ///    （2026-10-23 用户反馈；导出走同一条通道，也是坏的）
    ///
    /// 自测模式下原生不真的弹面板（模态面板会把自测卡死），只记一笔。
    private func filePanelIsWired() {
        controller.suppressOpenPanel = true

        // ① 导出：让它**真的落盘**到一个临时目录，验整条链。
        //    只断言"面板要弹了"证明不了文件真的写出来了 ——
        //    而 <a download> 的失败恰恰是静默的（点跟没点一样）。
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("lc-selftest-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.controller.autoSaveDirectory = dir
        let beforeTypes = self.controller.bridge.receivedTypes
        self.js("""
        var e = document.getElementById('btnExport');
        if (e) e.click();
        window.__st = JSON.stringify({ opened: !!e });
        """)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            guard let self else { return }
            self.js("""
            var opts = document.querySelectorAll('#modalCard .opt');
            if (opts.length) opts[0].click();
            window.__st = JSON.stringify({ n: opts.length });
            """)
            // 等下载落盘（原生侧状态，web 的 __st 轮询管不了这个）
            self.waitDownload(timeout: 8.0) { [weak self] in
                guard let self else { return }
                let after = self.controller.bridge.receivedTypes
                let fresh = after.count > beforeTypes.count
                    ? Array(after[beforeTypes.count...]) : []
                self.expect(fresh.contains("downloadName"),
                            "导出前把建议文件名报给原生（保存面板要用）",
                            "本步收到=\(fresh)")
                // ⚠️ 这里必须用**计数**，不能用 sawOpenPanel ——
                //    导入那步已经把它置成 true 了，再断言一次等于什么都没验。
                let c = self.controller!
                self.expect(c.openPanelCount == 0,
                            "导出**不走**选文件那条通道（那是导入的）",
                            "openPanelCount=\(c.openPanelCount)")
                self.expect(c.sawDownload,
                            "导出转成了 WKDownload（.download 策略生效）",
                            "sawDownload=\(c.sawDownload)")
                self.expect(c.downloadPanelName != nil,
                            "保存面板等到建议文件名（面板和消息是两条异步通道，会竞态）",
                            "downloadPanelName=\(c.downloadPanelName ?? "nil")")
                self.expect(c.downloadError == nil,
                            "下载没报错",
                            "downloadError=\(c.downloadError ?? "nil")")
                self.expect(c.downloadFinished,
                            "下载完成（WebKit 收到了落盘目标）",
                            "downloadFinished=\(c.downloadFinished)")

                // 文件真的在磁盘上，而且内容是这份画布
                let fname = c.downloadPanelName ?? ""
                let fpath = dir.appendingPathComponent(fname)
                let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
                self.expect(files.contains(fname),
                            "文件真的落盘了",
                            "目录内容=\(files)")
                if let data = try? Data(contentsOf: fpath),
                   let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                    let meta = obj["meta"] as? [String: Any]
                    let lib = obj["library"] as? [String: Any]
                    // ⚠️ 不能断言"节点数 > 0" —— 示例空间是**按需载入**的，
                    //    空画布导出 0 节点是对的。自测跑的是用户真实容器，
                    //    里面可能是空的。断结构，不断数据量。
                    let keys = ["nodes", "edges", "themes", "stages",
                                "versions", "milestones", "customStatuses"]
                    let allKeys = keys.allSatisfy { lib?[$0] != nil }
                    let nodeCount = (lib?["nodes"] as? [Any])?.count ?? 0
                    let counts = meta?["counts"] as? [String: Any] ?? [:]
                    // counts 是导出时算的，必须和 library 里的实际条数一致
                    let countsMatch = (counts["nodes"] as? Int) == nodeCount
                        && (counts["edges"] as? Int) == ((lib?["edges"] as? [Any])?.count ?? -1)
                    self.expect(meta?["app"] as? String == "人生画布"
                                && allKeys && countsMatch,
                                "落盘的是完整 JSON 备份（meta + library 七件套 + counts 对得上）",
                                "app=\(meta?["app"] ?? "nil") 七件套=\(allKeys) "
                                + "counts.nodes=\(counts["nodes"] ?? "nil") 实际=\(nodeCount) "
                                + "counts.edges=\(counts["edges"] ?? "nil") 实际=\((lib?["edges"] as? [Any])?.count ?? -1)")
                } else {
                    self.fail("落盘的是完整 JSON 备份（meta + library + 节点）",
                              "读不出 JSON：\(fpath.lastPathComponent)")
                }
                say("        （导出文件留在 \(fpath.path)）")

                // ② 导入往返：把刚导出的这个文件**导回去**。
                //    这是用户报的那条链（选文件 → 覆盖导入），
                //    光断言"面板请求到了"证明不了文件真的送进了 web。
                //    先把导出面板关掉 —— 不关的话它还开着，
                //    后面按"面板开着"判断会误判成导入的确认框出现了。
                self.js("""
                var acts = document.querySelectorAll('#modalCard .modal-acts .btn');
                if (acts.length) acts[0].click();
                """)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    guard let self else { return }
                    // 原生自己读文件、把内容送回 web（不走 WebKit 的文件输入）
                    self.controller.autoImportFile = fpath
                    let beforeImport = self.controller.bridge.receivedTypes
                    self.js("""
                    var t = document.getElementById('toast');
                    if (t) t.textContent = '';
                    var b = document.getElementById('btnImport');
                    if (b) b.click();
                    """)
                    // 等确认框 —— 按**内容**等，不按"面板开着"等
                    self.waitJS("((document.getElementById('modalCard')||{}).textContent||'').indexOf('覆盖当前全部数据') >= 0",
                                timeout: 8.0) { [weak self] gotConfirm in
                        guard let self else { return }
                        let afterImport = self.controller.bridge.receivedTypes
                        let gotOpenImport = afterImport.count > beforeImport.count
                            && Array(afterImport[beforeImport.count...]).contains("openImport")
                        self.expect(gotOpenImport,
                                    "导入：web 发出 openImport，原生自己弹面板读文件",
                                    "gotOpenImport=\(gotOpenImport) 本步收到=\(Array(afterImport[beforeImport.count...]))")
                        self.expect(gotConfirm,
                                    "导入：文件内容送到 web → 弹出「覆盖确认」框（框里带着文件名）",
                                    "gotConfirm=\(gotConfirm)")
                        let c2 = self.controller!
                        self.expect(c2.openPanelCount == 0,
                                    "导入**不走** WebKit 的文件输入（那条路会偶发交不到文件）",
                                    "openPanelCount=\(c2.openPanelCount)")
                        // 点「覆盖导入」
                        self.js("""
                        var ok = document.querySelectorAll('#modalCard .modal-acts .btn.acc');
                        if (ok.length) ok[0].click();
                        """)
                        self.waitJS("(document.getElementById('toast')||{}).textContent === '导入完成'",
                                    timeout: 8.0) { [weak self] done in
                            guard let self else { return }
                            self.expect(done,
                                        "导入完成（覆盖写入成功）",
                                        "toast=导入完成? \(done)")
                            try? FileManager.default.removeItem(at: dir)
                            self.advance()
                        }
                    }
                }
            }
        }
    }

    /// 自测开始前：把界面语言**锁成中文**。
    ///
    /// ⚠️ 为什么必须锁：
    ///    自测的断言全是**中文文案**（「贴图」按钮、「覆盖当前全部数据」…）。
    ///    用户把界面切成英文后，这些断言全都找不到 —— 表现是 16 条红，
    ///    看起来像"app 坏了"，其实只是"界面不是中文"。
    ///    （2026-11-12 实测：同一份代码，英文界面 16 红，中文界面全绿。）
    ///
    ///    跟 e2e.cjs / stress.cjs 是同一个道理 —— 那两个脚本也把界面锁成中文。
    ///
    /// 怎么锁：走**真实设置面板**（点「简体中文」那个按钮），不是偷改 localStorage。
    /// 走真实路径才会顺带把原生顶栏也刷成中文（原生跟着 web 走）。
    /// 跑完由 restoreLocale() 还原成用户原来的偏好 —— 自测不能给用户留状态。
    private func forceChineseLocale() {
        // 先记下用户原来的偏好，跑完要还回去。
        self.js("""
        var L = window.__lcLocale ? window.__lcLocale() : null;
        window.__st = JSON.stringify({ ok: L ? 1 : 0, pref: L ? L.pref : 'auto' });
        """)
        self.poll("读原来的语言偏好") { [weak self] j in
            guard let self else { return }
            self.savedLocalePref = self.s(j, "pref", "auto")
            guard self.b(j, "ok") else {
                self.skip("把界面锁成中文", "没有 __lcLocale 钩子（web 侧还没起来）")
                return
            }
            self.js("""
            document.getElementById('btnSettings').click();
            window.__st = JSON.stringify({ clicked: 1 });
            """)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                guard let self else { return }
                self.js("""
                (function(){
                  // 按位置找语言那一组（设置面板里第一个 .scale-pick）的第 2 个按钮 = 简体中文。
                  // 不按文案找：万一哪天语言名也本地化了，按文案找就会点空。
                  var group = document.querySelectorAll('.scale-pick')[0];
                  var zh = group ? group.querySelectorAll('button')[1] : null;
                  if (!zh) { window.__st = JSON.stringify({ found: 0 }); return; }
                  zh.click();
                  window.__st = JSON.stringify({ found: 1 });
                })()
                """)
                self.poll("切到简体中文") { [weak self] j2 in
                    guard let self else { return }
                    guard self.b(j2, "found") else {
                        self.skip("把界面锁成中文", "设置面板里没有「简体中文」按钮")
                        return
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                        guard let self else { return }
                        self.js("""
                        var L = window.__lcLocale ? window.__lcLocale() : null;
                        window.__st = JSON.stringify({ locale: L ? L.locale : '?' });
                        """)
                        self.poll("确认已切到中文") { [weak self] j3 in
                            guard let self else { return }
                            self.expect(self.s(j3, "locale", "?") == "zh-CN",
                                        "自测期间界面锁成中文（断言认的是中文文案）",
                                        "locale=\(self.s(j3, "locale", "?")) 原偏好=\(self.savedLocalePref)")
                            self.advance()
                        }
                    }
                }
            }
        }
    }

    /// 自测跑完：把语言偏好还原成用户原来的那个。
    ///
    /// ⚠️ 自测跑在**用户真实容器**上 —— 留着测试状态就是替用户改了设置。
    ///    还原的是**偏好**（不是显示语言）：偏好才是真源。
    ///
    /// ⚠️ 为什么按**位置**点那个按钮、不按文字找：
    ///    原来找的是「跟随系统」这个**文案**。可这一刻界面是英文
    ///    （localeSync 刚切过），英文里它叫「Follow system」——
    ///    按中文找根本找不着 ⇒ 还原**静默失败**，用户的偏好被留在 en-US 上
    ///    （自测给用户改了设置，而且不报任何错）。
    ///    （2026-11-12 基线对照实测：不含本次改动的老代码也会红同一条 ⇒ 老 bug，不是新引入的。）
    ///    现在按**结构**点：设置面板里第一个 .scale-pick 就是「语言」那一组，
    ///    三个按钮的顺序固定是 跟随系统 / 简体中文 / English —— 与界面语言无关。
    private func restoreLocale() {
        let want = self.savedLocalePref
        // 偏好 → 语言组里的第几个按钮（顺序固定：跟随系统 / 简体中文 / English）
        let idx = ["auto": 0, "zh-CN": 1, "en-US": 2][want] ?? 0
        self.js("""
        document.getElementById('btnSettings').click();
        window.__st = JSON.stringify({ clicked: 1 });
        """)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            guard let self else { return }
            self.js("""
            (function(){
              // ★ 按位置找，不按文案找（英文界面里没有「跟随系统」这几个字）
              var group = document.querySelectorAll('.scale-pick')[0];
              var b = group ? group.querySelectorAll('button')[\(idx)] : null;
              if (!b) { window.__st = JSON.stringify({ found: 0 }); return; }
              b.click();
              window.__st = JSON.stringify({ found: 1, picked: b.textContent });
            })()
            """)
            self.poll("还原语言偏好") { [weak self] j in
                guard let self else { return }
                self.expect(self.b(j, "found"),
                            "语言偏好已还原（没给用户留下测试状态）",
                            "还原成 \(want)")
                // ★ 真的还原了吗：读回偏好本身，别只信"点到了"
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                    guard let self else { return }
                    self.js("""
                    var L = window.__lcLocale ? window.__lcLocale() : null;
                    window.__st = JSON.stringify({ pref: L ? L.pref : '?' });
                    """)
                    self.poll("确认偏好已还原") { [weak self] j2 in
                        guard let self else { return }
                        self.expect(self.s(j2, "pref", "?") == want,
                                    "★ 偏好真的回到用户原来的那个（不是只点了个按钮）",
                                    "现在=\(self.s(j2, "pref", "?")) / 原来=\(want)")
                        self.advance()
                    }
                }
            }
        }
    }

    /// 设置面板里显示的版本号 == **正在跑的这个包**的版本。
    ///
    /// ★ 为什么这条不能省：
    ///   版本号有两个来源 —— 构建期注进去的（源码树）、原生报过来的（Bundle）。
    ///   一旦原生那条没接上（名字写错、没发出去），设置里就会安安静静地
    ///   显示**源码树的版本**，而用户装的是另一个包：数字看着像那么回事，
    ///   其实跟正在跑的东西对不上，而且**不报任何错**。
    ///   所以这里拿 web 显示的值跟原生 Bundle 里的值当面对账。
    private func versionShown() {
        let native = MainWindowController.bundleVersion
        // 走真实的原生动作通道打开设置面板（跟用户点菜单「设置…」同一条路）
        controller.bridge.send("action", ["action": "settings"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            guard let self else { return }
            self.js("""
            var V = window.__lcVersion ? window.__lcVersion() : null;
            var ver = document.querySelector('.set-ver');
            var titles = Array.from(document.querySelectorAll('.set-row-t')).map(function(x){ return x.textContent; });
            window.__st = JSON.stringify({
              ok: V ? 1 : 0,
              version: V ? V.version : '?',
              build: V ? V.build : '?',
              shown: ver ? ver.textContent.trim() : '',
              hasRow: titles.some(function(t){ return t.trim() === '版本'; })
            });
            """)
            self.poll("设置面板里的版本号") { [weak self] j in
                guard let self else { return }
                guard self.b(j, "ok") else {
                    self.skip("版本号", "没有 __lcVersion 钩子（web 侧还没起来）")
                    return
                }
                let shown = self.s(j, "shown", "")
                // 面板上显示的格式是「版本 (构建号)」——跟 Finder「关于本机」同一份数据。
                let expected = native.build.isEmpty ? native.short : "\(native.short) (\(native.build))"
                // ① 设置面板里确实有「版本」这一行（不是被删了、也不是挪没了）
                self.expect(self.b(j, "hasRow"),
                            "设置面板里有「版本」这一行", "面板里显示的是「\(shown)」")
                // ② 显示的值 == 正在跑的这个包的版本（Info.plist 里的那个）
                self.expect(!native.short.isEmpty && shown == expected,
                            "★ 设置里的版本 == 正在跑的这个包（Info.plist 的值）",
                            "设置里=\(shown) / 应该=\(expected)")
                // ③ 构建号也得带上（不然分不清同一个版本的两次打包）
                self.expect(native.build.isEmpty || shown.contains(native.build),
                            "版本号带上了构建号", "设置里=\(shown) / 构建号=\(native.build)")
                // 收尾：关掉面板，别影响后续步骤
                self.js("var m = document.getElementById('modal'); if (m) m.hidden = true; window.__st = '1';")
                self.advance()
            }
        }
    }

    /// 语言同步：web 界面和原生顶栏必须是**同一种语言**。
    ///
    /// ★ 这条盯的是一个真出过的 bug（2026-11-12 用户报「还是中文」）：
    ///   语言是**两边各管各的** —— web 管界面、原生管顶栏/菜单。
    ///   两边只要有一个没跟上，用户看到的就是"顶栏中文、界面英文"的分裂。
    ///
    ///   两个具体的坑：
    ///   ① 图例 chip 是「**只建一次**」的 DOM —— 切语言时标题变了、
    ///      chip 还是旧语言（读整页文字发现不了，必须单独读 chip）。
    ///   ② 原生启动时按系统语言摆界面，web 可能定成另一种 ——
    ///      不让 web 主动报一次，两边永远对不上。
    ///
    /// 测法：切到 English → ① web 图例 chip 全是英文（没有汉字）
    ///        ② 原生顶栏也全是英文（跟 web 同一语言）。
    /// 测完**切回原来的语言**（自测跑在用户真实容器上，不能留下副作用）。
    private func localeSync() {
        // 记下现在的语言，测完要还回去。
        self.js("""
        var L = window.__lcLocale ? window.__lcLocale() : null;
        window.__st = JSON.stringify({
          ok: L ? 1 : 0,
          locale: L ? L.locale : '?',
          pref: L ? L.pref : '?',
          legend: L ? L.legend : [],
          toolbar: L ? L.legend : []
        });
        """)
        self.poll("读当前语言") { [weak self] j in
            guard let self else { return }
            guard self.b(j, "ok") else {
                self.skip("语言同步", "没有 __lcLocale 钩子（web 侧还没起来）")
                return
            }
            let savedLocale = self.s(j, "locale", "zh-CN")

            // 切到 English：走真实的设置面板路径（点语言那一组的 English）。
            self.js("""
            (function(){
              document.getElementById('btnSettings').click();
              window.__st = JSON.stringify({ clicked: 1 });
            })()
            """)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                guard let self else { return }
                self.js("""
                (function(){
                  var btns = Array.from(document.querySelectorAll('.scale-pick button'));
                  var en = btns.filter(function(b){ return b.textContent.trim() === 'English'; })[0];
                  if (!en) { window.__st = JSON.stringify({ found: 0, all: btns.map(function(b){return b.textContent;}) }); return; }
                  en.click();
                  window.__st = JSON.stringify({ found: 1 });
                })()
                """)
                self.poll("切到 English") { [weak self] j2 in
                    guard let self else { return }
                    guard self.b(j2, "found") else {
                        self.skip("语言同步", "设置面板里没有 English 按钮")
                        return
                    }
                    // 等重绘 + 原生收到 localeChanged 并刷完顶栏
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                        guard let self else { return }
                        self.js("""
                        var L = window.__lcLocale ? window.__lcLocale() : null;
                        window.__st = JSON.stringify({
                          ok: L ? 1 : 0,
                          locale: L ? L.locale : '?',
                          legend: L ? L.legend : [],
                          edge: L ? L.edgeLegend : []
                        });
                        """)
                        self.poll("读切完后的语言") { [weak self] j3 in
                            guard let self else { return }
                            let locale = self.s(j3, "locale", "?")
                            let legend = self.arr(j3, "legend")
                            let edge = self.arr(j3, "edge")

                            // ① web 侧：语言真的切了 + 图例 chip 跟着换了
                            self.expect(locale == "en-US",
                                        "web 切到了 English（从 \(savedLocale) 切过来）",
                                        "locale=\(locale)")
                            // 图例 chip 里不许再有汉字 —— chip 是「只建一次」的 DOM，
                            // 忘了刷就会留在旧语言上（标题变了、chip 没变）。
                            let cjk = legend.filter { s in
                                s.range(of: "[\\u4e00-\\u9fff]", options: .regularExpression) != nil
                            }
                            self.expect(legend.isEmpty == false && cjk.isEmpty,
                                        "★ 图例 chip 跟着换语言了（不是旧语言的残留）",
                                        cjk.isEmpty
                                            ? "chip=\(legend.prefix(4).joined(separator: " / "))"
                                            : "这些 chip 还是中文：\(cjk.prefix(4).joined(separator: " / "))")
                            let edgeCJK = edge.filter { s in
                                s.range(of: "[\\u4e00-\\u9fff]", options: .regularExpression) != nil
                            }
                            self.expect(edge.isEmpty == false && edgeCJK.isEmpty,
                                        "★ 连线类型 chip 也跟着换了",
                                        edgeCJK.isEmpty
                                            ? "chip=\(edge.prefix(4).joined(separator: " / "))"
                                            : "这些 chip 还是中文：\(edgeCJK.prefix(4).joined(separator: " / "))")

                            // ② 原生侧：顶栏也必须是英文（跟 web 同一语言）
                            let toolbar = self.controller.toolbarTexts
                            let toolbarCJK = toolbar.filter { s in
                                s.range(of: "[\\u4e00-\\u9fff]", options: .regularExpression) != nil
                            }
                            self.expect(toolbarCJK.isEmpty,
                                        "★ 原生顶栏跟 web 同一语言（不再是中文顶栏 + 英文界面）",
                                        toolbarCJK.isEmpty
                                            ? "顶栏=\(toolbar.prefix(4).joined(separator: " / "))"
                                            : "顶栏这些还是中文：\(toolbarCJK.joined(separator: " / "))")

                            // 还原不在这一步做 —— 统一由最后的 restoreLocale()
                            // 还原成用户**原来的偏好**（这里改的只是测试中间态）。
                            self.advance()
                        }
                    }
                }
            }
        }
    }

    /// 等原生侧下载落盘（web 的 __st 轮询管不了原生状态）
    private func waitDownload(timeout: TimeInterval, then: @escaping () -> Void) {
        let start = Date()
        func tick() {
            if self.controller!.downloadFinished || self.controller!.downloadError != nil {
                then()
                return
            }
            if Date().timeIntervalSince(start) > timeout { then(); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { tick() }
        }
        tick()
    }

    /// 读一次 JS 的返回值（字符串）
    private func readJS(_ body: String, then: @escaping (String) -> Void) {
        webView.evaluateJavaScript("String((function(){\nreturn (\(body));\n})())") { res, err in
            if let err { then("JSERR: \(err)"); return }
            then((res as? String) ?? "")
        }
    }

    /// 轮询 web 里某个条件成立。expr 是 JS 布尔表达式。
    private func waitJS(_ expr: String, timeout: TimeInterval, then: @escaping (Bool) -> Void) {
        let start = Date()
        func tick() {
            let body = "if (\(expr)) window.__st = 'ok';"
            // ⚠️ 结尾必须 String(window.__st) —— IIFE 本身返回 undefined，
            //    不取回变量就永远等不到 "ok"。
            webView.evaluateJavaScript("window.__st = undefined; (function(){\n\(body)\n})(); String(window.__st)") { res, _ in
                if (res as? String) == "ok" { then(true); return }
                if Date().timeIntervalSince(start) > timeout { then(false); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { tick() }
            }
        }
        tick()
    }

    // MARK: - 收尾

    private func done() {
        let passed = lines.filter { $0.hasPrefix("PASS") }.count
        say("")
        var summary = failures == 0
            ? "==> 全部通过（\(passed) 条断言）"
            : "==> \(failures) 条失败 / \(passed) 条通过"
        if skips > 0 { summary += "，\(skips) 条跳过" }
        say(summary)
        say("")
        say("未覆盖（需人工确认）：")
        say("  · 观感 —— 这轮没改任何像素，工具栏/侧栏好不好看只能人眼看")
        say("  · 空闲锁定 → 工具栏消失、解锁后回来")
        say("  · 系统深浅色切换 → web 主题跟随")
        say("  · WKWebView 内复制粘贴是否真的走 编辑 菜单")
        finish(lines.joined(separator: "\n"))
    }
}