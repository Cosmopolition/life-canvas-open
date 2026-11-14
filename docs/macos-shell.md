# macOS 原生外壳：WKWebView + 自定义 `app://` scheme

> **English summary**
>
> This document covers the macOS native shell: a `WKWebView` loads the built
> `dist/` bundle over a custom `app://` URL scheme, all business logic stays on
> the web side, and the native layer only owns window-level concerns. It also
> documents the App Sandbox entitlements, the file import/export paths, fifteen
> failure modes that fail silently (each written up as symptom / root cause /
> fix), and the `--shot` / `--selftest` tooling.

---

## 目录

- [1. 整体架构](#1-整体架构)
- [2. `app://` scheme 的实现要点](#2-app-scheme-的实现要点)
- [3. 沙盒与 entitlements](#3-沙盒与-entitlements)
- [4. 文件导入导出链路](#4-文件导入导出链路)
- [5. 十五道会静默失败的坑](#5-十五道会静默失败的坑)
- [6. 离屏截图（`--shot`）与自测（`--selftest`）](#6-离屏截图--shot-与自测--selftest)
- [7. 自测覆盖了什么 / 什么只能人眼看](#7-自测覆盖了什么--什么只能人眼看)
- [8. 签名三坑](#8-签名三坑)
- [9. 换 bundle id 怎么迁数据](#9-换-bundle-id-怎么迁数据)

---

## 1. 整体架构

### 1.1 分层原则

原生侧**一行业务逻辑都不重复实现**。顶栏、菜单只负责「发命令」，所有动作都由 web
去做；反过来，web 也不直接碰原生 API，只通过一条 JSON 消息通道对话。

```
macos/
  LifeCanvas/      ← 外壳本体（进版本库）
  SmokeTest/       ← go/no-go 冒烟探针（一次性资产，可复现）
  build.sh         ← npm run build → swiftc → 组装 .app → ad-hoc 签名
  release.sh       ← universal 二进制 + 正式签名 + 自检清单
```

构建**不依赖 `xcodegen` / `tuist` / 任何 `.xcodeproj`**：直接用 `swiftc` 编译，
在 `mktemp -d` 的暂存区里全新组装 `.app`，再用 `ditto` 覆盖进 `macos/.build/`。

```bash
./macos/build.sh                  # → macos/.build/LifeCanvas.app
open macos/.build/LifeCanvas.app
```

### 1.2 源码分工

| 文件 | 职责 |
|---|---|
| `main.swift` | 进程入口。建 `NSApplication`、装 delegate、`run()`。整个 UI 用代码搭，不走 nib |
| `AppDelegate.swift` | 解析 dist 路径 → 建主窗口 → 驱动 `--selftest` / `--shot` 两个工具模式 |
| `MainWindowController.swift` | 窗口、工具栏、菜单、`WKWebView`；实现 `BridgeDelegate` / `WKUIDelegate` / `WKNavigationDelegate` / `WKDownloadDelegate` |
| `Bridge.swift` | JS ↔ 原生的双向消息通道 |
| `SchemeHandler.swift` | 把 `app://` 请求映射到 `dist/` 里的文件 |
| `L10n.swift` | 原生侧的文案表（菜单栏 / 工具栏 / 标题 / 系统对话框） |
| `SelfTest.swift` | 断言式自测 |
| `WindowShot.swift` | 原生窗口离屏截图 |

### 1.3 双向通道（Bridge）

消息一律是 `{ type: String, ...payload }`：

```
web → 原生    window.webkit.messageHandlers.shell.postMessage({...})
原生 → web    window.__lcShell.cmd({...})
```

- **原生 → web**：`view` / `search` / `action` / `theme` / `locale` / `appInfo` /
  `focusCanvas` / `importFile` / `imageFile`
- **web → 原生**：`viewChanged` / `searchChanged` / `downloadName` / `openImport` /
  `openImage` / `filterChanged` / `contextChanged` / `lockChanged` /
  `localeChanged` / `themeChanged`

两处必须小心：

1. `WKUserContentController` 对 message handler 是**强引用**，直接注册 `self` 会形成
   永久循环引用，`webView` 永远不释放。外面套一层 `WeakProxy`。
2. web 模块还没求值完时 `window.__lcShell` 还不存在，首条命令会**静默丢掉**。
   所以 web 端 boot 完成会发一条 `ready`，在此之前原生侧的消息进队列缓存，
   `ready` 到了再一次性补发（同一 `type` 的重复消息只保留最后一条，别把队列灌爆）。

### 1.4 外观与语言

- **系统外观是「跟随系统」这一档的唯一事实来源**：启动时把窗口的
  `effectiveAppearance` 推给 web，之后每次系统深浅色变化都推。
  KVO 只在**变化时**回调，所以启动那一次必须手动推一次 —— 漏了就会出现
  「工具栏浅色、内容深色」。
- 设置里的主题是三态：**跟随系统 / 暗色 / 亮色**。选「跟随系统」= 交还给系统；
  选暗色/亮色 = 把窗口外观钉死，系统再变也不动。
- 界面语言中英两套。**语言谁说了算**：

  ```
  用户显式偏好（设置面板里锁过）  >  原生报来的系统语言  >  浏览器语言
  ```

  macOS 的「每个 App 单独设语言」只对原生进程生效，网页里的 `navigator.language`
  看不到它，所以原生按系统语言报一次 `{ type: 'locale', locale }`；web 只在
  「用户没显式选过语言」时采纳它。

> 原生的 `Info.plist` 里必须声明 `CFBundleLocalizations`（`zh-Hans` + `en`），
> 否则用户在系统设置里给这个 App 单独设语言是白设。

---

## 2. `app://` scheme 的实现要点

### 2.1 为什么不用 `file://`

`file://` 下 origin 不透明，**IndexedDB / Worker 全部不可用**（实测）。
自定义 scheme 既是「不透明 origin」的解药，又让 web 侧完全不用为桌面端改写。

```swift
let config = WKWebViewConfiguration()
config.setURLSchemeHandler(SchemeHandler(root: distRoot), forURLScheme: "app")
config.defaultWebpagePreferences.allowsContentJavaScript = true
// ...
webView.load(URLRequest(url: URL(string: "app://local/index.html")!))
```

`app://local` 会被 WebKit 视为 **secure context** —— 这是 `crypto.subtle` 可用的前提
（冒烟测试实测：`isSecureContext === true`）。

### 2.2 SchemeHandler 的响应流程

`macos/LifeCanvas/SchemeHandler.swift` 的处理顺序：

1. `url.path` 为空或 `/` → 换成 `/index.html`；
2. 去掉查询串（`?stress=N` 之类）；
3. `standardizedFileURL` 之后**必须仍在 root 之内** —— 防目录穿越；
4. 路径不存在 → **SPA 回退**：返回 `index.html` 而不是 404；
5. 是目录 → 返回该目录下的 `index.html`；
6. 读文件 → `didReceive(response)` → `didReceive(data)` → `didFinish()`。

MIME 按扩展名查表，**必须是裸 MIME**：

```swift
private static let response(for requestURL: URL, servedAt fileURL: URL, data: Data) -> URLResponse {
    let ext = fileURL.pathExtension.lowercased()
    return URLResponse(
        url: requestURL,                                  // ← 必须是「请求」的 URL
        mimeType: mime[ext] ?? "application/octet-stream", // ← 裸 MIME，不带 charset
        expectedContentLength: data.count,
        textEncodingName: "utf-8"                          // ← 字符集单独传
    )
}
```

三个要点，每个都对应下面的一个坑：

- `url:` 传**请求的 URL**（`app://local/index.html`），不能传磁盘上的 `file://` 路径
  —— 见 [坑 1](#1-urlresponse-的-url-必须是请求的-url不是磁盘路径)；
- `mimeType` 不能带 `"; charset=utf-8"` —— 见 [坑 3](#3-mimetype-必须是裸-mime)；
- 字符集走 `textEncodingName` 单独传。

### 2.3 冒烟测试验过什么

`macos/SmokeTest/` 是一个**一次性探针**，不是可分发 app：不做 `.app` bundle 打包，
scheme handler 直接读项目里的 `dist/`。它存在的意义是回答一个问题 ——
「把 web 装进 `WKWebView` + 自定义 scheme 之后，存储层、加密层、Worker 这三条依赖链
还成立吗？」

```bash
./macos/SmokeTest/run.sh
```

输出两行 `SHALLOW|{...}` 和 `DEEP|{...}`。判定标准：`indexedDB` / `crypto.subtle` /
`Worker` 三项都要 `true`，且 `isSecureContext` 必须为 `true`（否则 `subtle` 拿不到）。

| 项 | 结果 | 说明 |
|---|---|---|
| `isSecureContext` | ✅ `true` | `app://local` 被 WebKit 视为 secure context。这是最大的赌注，现在证伪了 |
| `indexedDB` | ✅ 开 + 读写成功 | Dexie 库建成，9 张表齐全 |
| `crypto.subtle` | ✅ | PBKDF2 → `deriveKey` AES-GCM 256 成功 |
| `Worker`（file + module） | ✅ | 真实的 `indexer.worker-*.js` 收发正常 |
| 跨启动持久化 | ✅ | phase1 写 marker → 退出 → phase2 原样读回 |
| 真应用 boot | ✅ | canvas 已绘制，Dexie 正常初始化 |

结论：**GO** —— 存储层、加密层、Worker 三条依赖链全部可用，web 侧不需要为桌面端做
任何改写。

探针本身也踩到两个坑：

- `mimeType` 不能带 `; charset=utf-8`（即 [坑 3](#3-mimetype-必须是裸-mime)）；
- **`indexer.worker` 没有启动消息**：worker 只在收到 `onmessage` 后才回。写探测时
  被动等 `onmessage` 必然超时 —— 要先发一条消息再等回复。否则两种 worker 全部
  timeout，很容易误判成「自定义 scheme 下 Worker 不可用」这个致命结论。

**还没验的**：带正式 bundle id + sandbox 的包，IndexedDB 会落到 app container 内，
持久化需要再验一次（参见 [9. 换 bundle id 怎么迁数据](#9-换-bundle-id-怎么迁数据)）。

---

## 3. 沙盒与 entitlements

`macos/LifeCanvas/LifeCanvas.entitlements`：

```xml
<key>com.apple.security.app-sandbox</key>
<true/>

<key>com.apple.security.network.client</key>
<true/>
<key>com.apple.security.network.server</key>
<false/>

<key>com.apple.security.files.user-selected.read-write</key>
<true/>

<key>com.apple.security.print</key>
<false/>
```

| entitlement | 值 | 为什么 |
|---|---|---|
| `app-sandbox` | `true` | 基础沙盒 |
| `network.client` | **`true`** | **必须**，哪怕这个应用一个网络请求都不发。见下 |
| `network.server` | `false` | 不起本地服务 |
| `files.user-selected.read-write` | `true` | 用户主动导出时打开保存面板；其余时间不读不写用户文件 |
| `print` | `false` | 用不到可删 |

### 3.1 为什么 `network.client` 必须为 true

WebKit 把 `app://` 的取数交给**独立的 NetworkProcess XPC 服务**，那边没有 outbound
权限就什么都取不到：页面永远停在 `about:blank`，`evaluateJavaScript` 全部返回
`Code=5`，**没有任何可见报错**。

实测：`sandbox + network.client=false` → **0/26** 断言通过；改成 `true` → 26/26。

这只是让 WebKit 自身能工作，代码里没有任何外发路径。

### 3.2 沙盒还有一个连带后果：读不到容器外的路径

App Sandbox 让 app **读不到自己容器以外**的路径。`LIFECANVAS_DIST=<项目路径>/dist`
这个目录「存在」（stat 得到），但 SchemeHandler 真正去读文件时会被沙盒拒掉 →
导航 `-1100` → 页面停在 `about:blank`。

所以 `resolveDist()` 必须验**可读**（读得到 `index.html` 本身），而不是验目录存在：

```swift
private static func readableDist(_ path: String) -> URL? {
    let index = URL(fileURLWithPath: path).appendingPathComponent("index.html")
    guard FileManager.default.isReadableFile(atPath: index.path) else { return nil }
    return URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
}
```

dist 路径解析顺序（首次命中即用）：

1. 环境变量 `LIFECANVAS_DIST` —— 开发期跑裸二进制时指定 dist 目录
2. `Bundle.main/Contents/Resources/dist` —— 装包后的正常路径
3. `../Resources/dist`（相对可执行）—— 容错

任何一条都拿不到就 `fatalError`：没 dist 启动也是空壳，不如早死好查。

> ⚠️ **免重打包热更必须用未签名的那个二进制**。打包好的 `.app` 带沙盒，读不到容器外
> 的 `dist`：
>
> ```bash
> LIFECANVAS_DIST="<你的项目路径>/dist" macos/.build/LifeCanvas-dev
> ```
>
> ⚠️ 未签名的二进制和 `.app` 读的是**两个不同的库**（沙盒内外的 IndexedDB 各存各的）。
> 别拿开发构建里加的点去跟 `.app` 里对账 —— 会以为数据丢了。

---

## 4. 文件导入导出链路

### 4.1 三个前置条件

**① `uiDelegate` 必须设置**，否则「选文件」和「存到哪」这两个请求会被 WebKit
**静默丢弃** —— 不弹面板、不报错：

```swift
webView.uiDelegate = self
```

**② 面板必须推到下一个 runloop 再开**。`runOpenPanelWith` 是在 WebKit 内部状态机里
回调的，同步开面板会让 WebKit 认为这次交互还没结束：

```swift
DispatchQueue.main.async {
    // …在这里才弹 NSOpenPanel / NSSavePanel
}
```

**③ 同样的道理适用于 JS 对话框**。`WKUIDelegate` 里不实现
`runJavaScriptAlertPanelWithMessage` / `runJavaScriptConfirmPanelWithMessage` 时，
WebKit 会把 `window.confirm()` 当成「用户点了取消」直接返回 `false`，
`window.alert()` 则什么都不弹 —— 网页里的「删除」按钮点了没反应，**不报错**。

### 4.2 导出：`<a download>` → `WKDownload`

WebKit 看到 `<a download>` 会把这次导航标成 `shouldPerformDownload = true`。
**必须回 `.download`**：

```swift
func webView(_ webView: WKWebView,
             decidePolicyFor navigationAction: WKNavigationAction,
             decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
    decisionHandler(.allow)
}
```

回 `.allow` 的话，WebKit 会**真的去导航那个 `blob:` URL** —— 结果是：不弹保存面板、
不落盘、不报错，点了跟没点一样。

回 `.download` 之后 WebKit 走 `WKDownload`：

```
webView(_:navigationAction:didBecome:)           ← 装 delegate
  → download(_:decideDestinationUsing:suggestedFilename:completionHandler:)
       ← 这里弹 NSSavePanel，把用户选的位置交回 WebKit，文件由 WebKit 写
```

⚠️ `blob:` 的 `suggestedFilename` **不可靠**（实测是 `"Unknown"`），别指望它。

### 4.3 建议文件名是另一条异步通道（会竞态）

`runOpenPanelWith` 和 `WKDownload` 都**不带**建议文件名 —— 只有 web 侧知道
（`<a download="life-canvas-2026-10-23.json">`）。所以 web 点下载前先发一条
`downloadName` 消息报上来。

但「面板请求」（WebKit → 原生）和「名字消息」（web → 原生）是**两条独立通道**，
谁先到不保证。先读为空就弹「未命名」，后面名字到了也来不及用 ⇒ 原生侧轮询一小会儿
再开面板：

```swift
private func awaitDownloadName(_ done: @escaping (String?) -> Void) {
    if let n = pendingDownloadName { pendingDownloadName = nil; done(n); return }
    var tries = 0
    func tick() {
        if let n = pendingDownloadName { pendingDownloadName = nil; done(n); return }
        tries += 1
        if tries >= 40 { done(nil); return }   // 40 × 10ms = 400ms
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { tick() }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { tick() }
}
```

### 4.4 导入：原生自己读文件，不走 `<input type=file>`

`<input type=file>` 偶发拿不到文件（见 [坑 7](#7-input-typefile-拿文件会偶发拿不到--所以导入不走这条路)），
所以原生模式的导入走**另一条通道**：

```
web  → emit('openImport')
原生 → NSOpenPanel → 自己读文件 → bridge.send('importFile', {name, text})
web  → 拿到内容 → 确认框 → 覆盖导入
```

原生自己读（用户选过的文件，原生有权限），再把**内容**送回 web，中间没有那个不可靠的环节。
顺带还能给出真正的错误（读不了 / 不是 UTF-8），而不是「点了没反应」。

浏览器模式没有原生，仍然用 `<input type=file>`（`isNative()` 分流）。
原生侧的 `runOpenPanelWith` 实现保留着当兜底 —— 万一哪天 web 又用了文件输入，
别静默丢弃。

### 4.5 贴图：原生自己弹面板 + 自己缩放

```
web「贴图」按钮 → emit('openImage') → 原生 NSOpenPanel（png/jpg/gif/bmp/tiff/webp/heic/heif）
  → 原生 ImageIO 读文件 + 缩放（长边 ≤ 800px，转 JPEG 0.85，HEIC 也转）
  → bridge.send('imageFile', {name, dataUrl, w, h}) → web 入库
```

缩放放在**原生侧**是有意的：一张手机照片 3–5MB，base64 之后 4–7MB，塞进 JSON 走
`evaluateJavaScript` 会卡住主线程；缩到长边 ≤800px 之后只剩 ~50KB。

原生侧的两个参数必须和 web 侧 `src/canvas/image-input.ts` 的 `MAX_DIM` / `QUALITY`
一致（浏览器模式和桌面模式缩出来的图应该长得一样）。**改一边就要改另一边。**

---

## 5. 十五道会静默失败的坑

都不报错，只是某处莫名其妙不工作。都是实测踩出来的，别「优化」回去。

### 1. `URLResponse` 的 url 必须是**请求**的 URL，不是磁盘路径

**症状**：页面永远停在 `about:blank`，`location.href` 就是 `about:blank`；
**不回调 `didFail`**，导航不提交也不报错，而且再也不会去请求 `assets/*`。

**根因**：传了 `file://` 路径时，WebKit 认为响应对不上请求，直接丢弃：

```swift
// 对：
URLResponse(url: requestURL, ...)     // app://local/index.html
// 错：
URLResponse(url: fileURL, ...)        // file:///…/dist/index.html
```

**修法**：`URLResponse` 的 `url` 一律传 `urlSchemeTask.request.url`。

### 2. App Sandbox 下 `com.apple.security.network.client` 必须为 true

**症状**：哪怕应用一个网络请求都不发，页面也取不到任何东西；每次
`evaluateJavaScript` 都返回 `Code=5`，**没有任何可见报错**。

**根因**：WebKit 把 `app://` 的取数交给独立的 NetworkProcess XPC 服务，那边没有
outbound 权限就什么都取不到。实测：`sandbox + network.client=false` → 0/26 断言通过。

**修法**：`network.client` 设 `true`。这只是让 WebKit 自身能工作，代码里没有任何外发路径。

### 3. `mimeType` 必须是裸 MIME

**症状**：页面被当纯文本渲染成 `<pre>`（HTML 源码被转义后塞进去），整页白；
不报任何错。

**根因**：写了 `"text/html; charset=utf-8"`。Foundation 原样存这串，WebKit 按
**精确类型**查表，带参数就查不到。

**修法**：`mimeType` 只写裸 MIME（`text/html`），字符集走 `textEncodingName` 单独传。

### 4. 不设 `uiDelegate` → 文件面板请求被**静默丢弃**

**症状**：点「选择接收文件」什么都不会发生 —— 不弹面板、不报错。用户报的是
「我点了选择接收文件，怎么又回到画布了」。

**根因**：`WKUIDelegate.webView(_:runOpenPanelWith:initiatedByFrame:completionHandler:)`
不实现的话，WebKit 会把「选文件」（`<input type=file>`）和「存到哪」
（`<a download>`）这两个请求直接丢掉。

**修法**：

```swift
webView.uiDelegate = self   // 少了这行，导入和导出都不报错，只是点了没反应
```

### 5. `<a download>` 必须回 `.download`，回 `.allow` 等于什么都不做

**症状**：点了导出，不弹保存面板、不落盘、不报错 —— 点了跟没点一样。

**根因**：回 `.allow` 的话，WebKit 会**真的去导航那个 `blob:` URL**。

**修法**：

```swift
if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
decisionHandler(.allow)
```

（实测：`blob` 的 `suggestedFilename` 是 `"Unknown"`，别指望它。）

### 6. 建议文件名是**另一条异步通道**，会竞态

**症状**：保存面板弹出来，文件名是「未命名」，而 web 侧明明传了
`download="life-canvas-2026-10-23.json"`。

**根因**：`runOpenPanelWith` 和 `WKDownload` 都**不带**建议文件名，只有 web 侧知道。
「面板请求」和「downloadName 消息」是两条独立通道，谁先到不保证。先读为空就弹
「未命名」，后面名字到了也来不及用。

**修法**：web 点下载前先 `emit('downloadName', {name})` 报上来；原生侧
`awaitDownloadName` 轮询一小会儿（40 × 10ms = 400ms）再开面板。

### 7. `<input type=file>` 拿文件会**偶发拿不到** —— 所以导入不走这条路

**症状**：原生这边面板选好了、文件确实在磁盘上，web 那边 `input.files` 却是空的，
`onchange` 拿不到文件，导入**静默没反应**。实测复现率大概 **1/10**（自测里 20 轮
有 2 轮失败，失败形态完全一样：面板请求到了，但确认框没出来）。

**根因**：这是 WebKit 把文件交给 web 进程那一步不稳，跟原生侧没关系。

**修法**：**原生模式的导入不走 `<input type=file>`** —— 原生自己读文件、再把内容送回
web（见 [4.4](#44-导入原生自己读文件不走-input-typefile)）。浏览器模式没有原生，
仍然用 `<input type=file>`（`isNative()` 分流）。

### 8. 原生发「切视图」可能早于 web 建好画布

**症状**：第一次进画布，「定位并自适应」跑不了。**如果「已定位」标记在那之前就被用掉，
画布就永远停在没定位的状态**：画面上一片空白，缩放读数停在 100%，而点其实都在。

**根因**：web 的 `ready` 是在**读库之前**发的（`enableShell()` 之后立刻发），而
`CanvasView` 是在读库、建完索引之后才建的。原生这边任何「切视图」的命令，都可能在
web 还没建好画布时就到 —— Bridge 会把它排队，web 一发 ready 就补发。于是 web 收到
「切到画布」时 `this.canvas` 还是 `undefined`。

**修法**：

- web 侧：**跑不了定位就把标记退回去**，等下次真的能定位时重来；`fit()` 也返回
  「有没有真的装下」。
- 截图工具侧：改成**等 web 真的就绪**（`__lcVp` 出现 = `CanvasView` 建好了）再切视图，
  不要固定等几秒 —— 读库慢的时候 web 还没建好画布，切过去只会得到一个「没定位」的
  空画布，**而且截图看起来还挺正常（只是空的）**，很容易当成 app 坏了。

### 9. 贴图走 `<input type=file>` —— 面板写死了只收 JSON，桌面端贴图选不了图

> ✅ **已修**。下面是当时的坑，留着当来龙去脉。

**症状**：用户想选一张 PNG/JPG 贴到节点上，面板里**选不到**。实测确认：原生侧确实
收到了面板请求，但允许类型固定是 `.json`。

**根因**：原生侧 `runOpenPanelWith` 写死了 `panel.allowedContentTypes = [.json]`，
而 `WKOpenPanelParameters`（本机 SDK）**只有** `allowsMultipleSelection` /
`allowsDirectories`，**没有 `allowedContentTypes`** —— web 侧那个
`accept="image/*"` 根本传不到原生侧，原生无从知道这次要的是 JSON 还是图片。
再叠加 [坑 7](#7-input-typefile-拿文件会偶发拿不到--所以导入不走这条路)（约 1/10
概率 `input.files` 为空），这条路在原生模式下是**双重不可靠**。

**修法**：跟导入一样，原生自己走一条通道（见 [4.5](#45-贴图原生自己弹面板--自己缩放)）：
原生弹面板（`allowedContentTypes` = png/jpg/jpeg/gif/bmp/tiff/webp/heic/heif）→
自己读 → 自己缩放 → 把 dataURL 送回 web → web 入库。

### 10. canvas 的 `ctx.font` 不认 CSS 变量 —— 整条赋值被**静默忽略**

**症状**：画布上的字**全都退回 `10px sans-serif`**。后果不是「字体不一样」，是
**字号全错**：

| 想画的 | 实际画的 | 后果 |
|---|---|---|
| 概览卡片标题 `11 / scale`（想让它常驻 11 屏幕像素） | 10 **世界**像素 | 缩到 25% 就是 **2.5 屏幕像素** —— 缩略图上写着「常驻屏幕字号」，实际根本看不见 |
| 主题 / 阶段标签 `12 / scale` | 10 世界像素 | 同样看不见 |
| 节点正文 `13.5 / scale` | 10 世界像素 | 放大到 200% 时字比该有的还小 |

而且它**看起来不像 bug** —— 只是「字太小」，放大截图才看得出来。

**根因**：`ctx.font` 虽然是 CSS font shorthand，但它**不认 CSS 变量**。原来写的是：

```ts
g.font = `600 ${fs}px var(--ui-font, system-ui), system-ui, sans-serif`;
```

含 `var()` 的整条赋值被判为非法 → **直接被忽略**，没有任何报错。

**修法**：把变量**读出来**再用（`src/canvas/renderer.ts` 的 `uiFont()`）：

```ts
const v = getComputedStyle(document.documentElement).getPropertyValue('--ui-font');
g.font = `600 ${fs}px ${v}`;
```

> 注意：**SVG** 里的 `font-family="var(--ui-font)"` 是好的（表现属性按 CSS 解析，
> 浏览器认 `var()`）。只有 canvas 的 `ctx.font` 不认。别把 SVG 那套照搬到 canvas。

### 10b. macOS 的 `system-ui` **自带中文** —— 它会「吞掉」后面的中文字体

**症状**：画布上的中文「说不上哪里怪，就是硬、糙」。

**根因**：字体栈原本是：

```css
--ui-font: system-ui,-apple-system,"PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif;
```

看起来中文会落到 "PingFang SC"，**不会**。macOS 的 `system-ui` 是复合字体
`.AppleSystemUIFont`，它**自己就带中文字面** —— 于是每个字符在 `system-ui` 就被匹配上，
**根本轮不到后面的 "PingFang SC"**。

实测（"杭州E类人才自动签到恢复" @44px 的宽度）：

| 字体 | 宽度 |
|---|---|
| `system-ui` / `-apple-system`（实际生效的） | **497.84** |
| `"PingFang SC"` | 512.03 |
| `"Heiti SC"` | 507.58 |
| `"Hiragino Sans GB"` | 512.29 |
| `sans-serif` | 513.35 |

没有候选对得上 497.84 —— 它就是系统复合字体自带的那个面（笔画均匀、形状偏旧）。
网页 UI 用的是同一条栈，所以两边**一样**（实测 DOM 与 canvas 解析完全一致，
498.45 vs 498.44）—— 不是「画布和网页不一致」，是这条栈本身的问题。

**修法**：别让 `system-ui` 待在栈的前面。`"SF Pro Text"` 只覆盖拉丁/数字，中文按字符
回退落到 "PingFang SC"：

```css
--ui-font: "SF Pro Text","PingFang SC","Microsoft YaHei","Noto Sans SC",sans-serif;
```

改完画布和网页一起变（画布从 `getComputedStyle` 读同一个变量）。

> 顺带一提：这条坑之所以容易被漏掉，是因为坑 10 让画布那整条 font 串**非法**，
> 画布一直退回默认 `10px sans-serif` → 中文 2.5 屏幕像素（看不见）。
> 修好 font 之后它第一次真正露脸，才谈得上「好不好看」。

### 11. `img.onload` 只说明「数据到了」，不说明「**能画了**」

**症状**：右栏检视面板里图清清楚楚（那里是 `<img>` 标签，浏览器自己会解码），
画布上永远是块灰底（那里是 `drawImage`）。而且是**偶发**的：解码够快就画得出来，
不够快就画不出来；换个缩放级别（走另一条渲染路径）又画出来了 —— 最难查的那种。

**根因**：WebKit 里，一张 `complete && naturalWidth > 0` 的图，`drawImage`
**仍然可能画不出东西** —— 因为解码还没完成。

**修法**：**`decode()` 兑现之后才算「能画」**，那时候才重绘：

```ts
img.onload = () => {
  const d = img.decode?.();
  if (d?.then) d.then(() => markDecoded(src), () => markDecoded(src));
  else markDecoded(src);
};
```

并且 `getImageOrLoad` 在 decode 兑现之前要返回 `null`（画占位底色），不然等于把一张
画不出来的图交给 `drawImage`。

### 12. fit 的 300ms 补间会把 `centerOn` / `zoom` 的结果冲掉

**症状**：「刚摆好又跳回去」，而且是**偶发**的（取决于补间还剩几帧）。

**根因**：`fit()` 是带动画的：300ms 内每一帧都改写视口。它还在跑的时候居中
（`centerOn`）或缩放（`zoom`），**下一帧就被动画改回去**。

**修法**：任何新的视口操作先 `cancelAnimationFrame` 掉正在跑的补间。

### 13. 缩放读数在渲染循环里更新 → 任何**绕过循环**的重绘都留下过期读数

**症状**：画布已经是 100% 了，读数还写着 25% —— **用户会以为缩放没生效**。

**根因**：缩放读数（`#zv`）原来在渲染循环里更新。只要有一次重绘绕过了循环
（`resize()` 的当场重绘、自测/截图用的 `renderNow()`），读数就是过期的。

**修法**：把读数更新挪进 `render()`，跟画布内容绑在一起。

### 14. 自测跑在**用户真实容器**上 —— 改用户的数据必须精确到 id

**症状**：自测会往用户的库里贴图，清理时删错对象 ⇒ 用户自己的照片被删了。

**根因**：自测挑点要挑「当前没有图」的：检视面板的按钮文案按状态变 —— 已经有图的点
显示「换图（上传）」，没图的才显示「贴图（…）」。自测按「贴图」两个字找按钮，
挑中一个带图的点就永远找不到，**看起来像功能坏了，其实只是找错了按钮**。

**修法**：清理时**绝不能**删「第一个有图的点」，必须按 id 精确删：

```swift
window.__lcRemoveImage('<nodeId>')   // nodeId 是自测自己那个点
```

### 15. 沙盒里的 .app 读不到容器外的 dist —— 页面停在 about:blank，全线假红

**症状**：打包好的 `.app` 设了 `LIFECANVAS_DIST`（指向项目里的 `dist/`）之后，
`--selftest` 跑出 **31 条失败 / 5 条通过**，而且几乎每条的 detail 都是 `?`。
控制台里有一行：

```
导航失败(provisional) url=? err=Error Domain=NSURLErrorDomain Code=-1100
```

**根因**：App Sandbox 让 app **读不到自己容器以外**的路径。`LIFECANVAS_DIST` 指向的
目录「存在」（stat 得到），但 SchemeHandler 真正去读文件时被沙盒拒掉 → 导航 -1100
→ 页面停在 `about:blank`。

**为什么难认**：页面没加载时 DOM 是空的，而自测里好几条断言写成
`!g || g.hidden` 这种「元素不存在就算过」的形式 —— 在空 DOM 上它们**全部 PASS**，
看起来像「过了几条」，其实一条都没真的测到。是「导航失败」那行日志加上
`document.documentElement.outerHTML` 为空才定位到的。

**修法**（两处都改了）：

1. `resolveDist()` 改成验**可读**（读得到 `index.html`）而不是验目录存在 —— 读不到就
   自动回落到 bundle 里的 `Resources/dist`，**页面至少能开**。
2. `build.sh` 另出一个**未签名**的 `macos/.build/LifeCanvas-dev`。热更必须用它：
   没有沙盒才读得到外面的 `dist`。

---

## 6. 离屏截图（`--shot`）与自测（`--selftest`）

### 6.1 `--shot`：看原生窗口长什么样

把窗口**离屏**渲染成 PNG（AppKit 自己画，不需要「屏幕录制」权限）：

```bash
macos/.build/LifeCanvas.app/Contents/MacOS/LifeCanvas \
  --shot "$PWD/shots/native" --shot-size 1280x840 \
  --shot-view canvas --shot-appearance dark
```

| 参数 | 说明 |
|---|---|
| `--shot <目录>` | 必带。输出 `<目录>/window.png` |
| `--shot-size 1280x840` | 窗口尺寸 |
| `--shot-view today\|canvas\|tl\|lv\|wk` | 切到哪个视图 |
| `--shot-appearance dark\|light` | 强制窗口外观（不用改系统设置） |
| `--shot-js "<一段 JS>"` | 截图**之前**先在 web 里跑一段 JS（见下） |
| `--shot-view-early` | 不等 web 就绪就切视图（复现竞态用） |
| `--shot-image <路径>` | 截图前走**真实的贴图链**（原生读文件缩放 → 送回 web → 入库） |
| `--shot-stdout` | 不写文件，把 PNG 的 base64 打到 stdout（`SHOTPNG:<base64>`） |

**为什么不走 `screencapture` / `CGWindowListCreateImage`**：那两条路都要「屏幕录制」
权限，在自动化环境里拿不到 —— 截出来是空白。这里走 AppKit 自己的离屏绘制：取窗口的
theme frame（标题栏 + 工具栏 + 内容区都在这一层视图树里），`cacheDisplay` 进 bitmap rep，
不碰屏幕缓冲区。

**沙盒退回**：沙盒里 app 只能写自己的容器，所以第一次会写不进去、自动退回
`~/Library/Containers/<bundle-id>/Data/tmp/lifecanvas-shot-<pid>/window.png`，
把它拷出来即可。

> ⚠️ **容器里的文件，外部进程可能读不了内容**（macOS 的 App Data Protection：
> `stat` 可以、读不行）。这时用 `--shot-stdout`：
>
> ```bash
> LifeCanvas --shot /tmp/x --shot-stdout ... 2>/dev/null \
>   | grep '^SHOTPNG:' | sed 's/^SHOTPNG://' | tr -d '\n' | base64 -D > /tmp/x.png
> ```
>
> 走 stdout 就绕开了整条链路：app 打印，外层解码。

**每次截之前还会打一行 `WebState:`**，里面是 web 侧的真实状态（当前显示的视图、
原生分段高亮的视图、主题、左右栏宽度、分隔条位置、画布 CSS 尺寸与后备存储尺寸、
缩放读数）。

**光看截图会误判** —— 「分段高亮『今日』但屏幕上是画布」这种事，截图只显示画布，
必须对着 WebState 才看得出来。

**`--shot-js` 的用法**（截某种只有 web 侧能造出来的状态，比如侧栏收起后的全屏画布）：

```bash
--shot-js "$(cat /tmp/shot.js)"     # 脚本里直接 return 结果
```

- 脚本被当作**函数体**执行，所以要 `return`，不能只写一个 IIFE。
- 用 `callAsyncJavaScript` 而不是 `evaluateJavaScript`：后者不 await Promise。
- **切视图之前会等 web 真的就绪**（`__lcVp` 出现 = `CanvasView` 建好了 = 能定位了）。
  固定等 4 秒不靠谱：读库慢的时候 web 还没建好画布，切过去只会得到一个「没定位」的
  空画布 —— 而且截图看起来还挺正常（只是空的），很容易当成 app 坏了。
- `--shot-js` 必须在状态 dump **之前**跑完 —— dump 是用来**核对**那张状态的，
  顺序反了 dump 的就是上一帧。

> **已知限制**：工具栏里的分段控件和圆角按钮是 vibrancy 材质画的，离屏绘制时材质
> 回退成白色 —— 深色外观下截出来是白底白字（白块）。那是**截图方式的限制，不是 app
> 的 bug**。要看深色下的真实观感，请直接开 app 切系统深色。

另外，截图/自测跑完会清掉**上一次**留下的临时产物（`lifecanvas-shot-*` /
`lc-selftest-*` 目录，以及一小时前的顶层 png）。这一步**只在工具路径上跑**，正常启动
不碰 —— 删文件这种事不该发生在用户双击 app 的时候。

### 6.2 `--selftest`：跑断言，不需要人眼

```bash
# ⚠️ 打包好的 .app 要**不设** LIFECANVAS_DIST（设了也读不到，见坑 15）
macos/.build/LifeCanvas.app/Contents/MacOS/LifeCanvas --selftest
```

- `--selftest` 会自动跨过首启的加密门禁和新手引导，然后逐档测断点。
- 起跑是一个 8 秒后的定时器，**不等 ready**：ready 没到的话第一条断言会如实报出来，
  而不是死等。
- 覆盖 **80 条断言**，输出 `PASS` / `FAIL` / `SKIP` 三种结果，末尾给出汇总。
- ⚠️ **退出码恒为 0**（报告打完就 `exit(0)`）—— 要看结果得读 stdout 的报告文本，
  别拿 `$?` 当判据。
- 截图权限拿不到、只能靠断言的时候，它就是替代品。

---

## 7. 自测覆盖了什么 / 什么只能人眼看

### 7.1 覆盖了什么（80 条断言）

- **布局**：web 顶栏让位、`--hd` 塌成 0、四个断点的三列实际宽度与抽屉开合；
- **画布**：后备存储是否等于 CSS×DPR（ResizeObserver 有没有生效）；
  **画布 resize 之后是不是当场就有内容**（设 `cv.width` 会清空位图，只置脏等下一帧的
  话，后台窗口的 rAF 被节流时画布会一直空着）；
- **侧栏**：分隔条拖到屏幕边 → 侧栏收起 → 画布变宽；收起后分隔条有没有整个留在屏幕内
  （不然用户找不到抓手）；双击恢复；
- **双向通道**：原生→web 的 view/search 链路、web→原生的回执；
- **导入导出整条链**：
  - 导出：点「导出」→ 转成 `WKDownload` → 真的**落盘**（文件在磁盘上、是合法 JSON、
    `meta.counts` 和 library 实际条数对得上）
  - 导入：点「导入」→ web 发 `openImport` → 原生弹面板读文件 → 内容送回 web →
    弹出带文件名的覆盖确认框 → 导入完成
  - 再把刚导出的那个文件导回去，构成**往返**
- **贴图整条链**（造一张 1200×800 的洋红 PNG，走的是和用户手点同一条路）：
  - 检视面板里找得到「贴图」按钮 → 原生收到请求（`imagePanelCount` 增加）
  - 贴图**不走** WebKit 的文件输入（`openPanelCount` 不变）
  - 原生把图读出来并缩放成 JPEG：1200×800 → **800×533**、长边 ≤ 800
  - 库里存的是 `data:image/jpeg;base64,` 开头的那张，尺寸和原生送回来的一致
  - **画布上真的画出了这张图**：数画布上的洋红像素
    - 精细路径（缩放 100%）：标题旁的 120px 缩略图 → 2 万多像素
    - 概览路径（缩放 25%）：卡片右上角的封面角标 → 一千多像素
  - 测完把测试图**按 id 精确删掉**（见 [坑 14](#14-自测跑在用户真实容器上--改用户的数据必须精确到-id)）
- **原生菜单「视图 → 重置画布」**那条链（重置按钮只在画布浮层里 —— 原生模式 web 顶栏
  整个被隐藏，入口放顶栏等于桌面端没有入口）：
  - 原生菜单项 → action 通道 → web 的 `runAction` → 点画布浮层里的「↺ 重置」
    （菜单项写错或选择器写错的话，原生点菜单**什么都不会发生**，而且不报错）
  - 重置后主题/阶段焦点、筛选、搜索、选中、点类型筛选**全清**，视口回到全局
  - **数据一个字节都没动**（重置前后节点数一致）
- **其它**：版本号显示、语言同步、文件面板已接线、空格隔离、周视图导入、卡片视图、
  检视卡片、设置面板打开。

### 7.2 几条关键设计

- **SKIP ≠ FAIL**：前置条件不成立时（比如库是空的，根本没有点可以贴图），自测报
  `SKIP` 而不是 `FAIL` —— 「这次没测到」和「测出了问题」必须分开，否则失败率会骗人
  （空库时那条红看着像「贴图功能坏了」）。
- **等信号，不等时长**：先等 `__lcImageReady`（decode 兑现了）再采样 —— 用「等 0.8 秒」
  是赌 decode 够快，赌输了就是**偶发**的红。
- **数特征色像素，不数颜色数**：颜色数只增不减，贴的那张图很可能全是画布上已有的
  颜色；洋红是画布配色里没有的颜色，数它才说明「这张图真的画上去了」。
- **两条断言依赖「没有过渡动画」**：自测会先注入 `*{transition:none !important}`。
  原因：抽屉靠 translateX 滑出屏外，断言读的是 transform 的**计算值**；而离屏 / 被
  遮挡的窗口里 CoreAnimation 不推进，transition 会卡在起始值（identity），
  「收起到屏外」就永远断言不过 —— 那是测量环境的问题，不是布局的问题。
- **自测会动到用户真实容器里的库**：往返导入导回的是同一份内容，所以是等价的；贴图
  那条**必须**把图还回去，所以自测挑的是一个**当前没有图**的点，测完按 id 删。
  后两条是真的在读写文件（临时目录，测完删）。

### 7.3 不覆盖，只能人眼看

- 观感
- 空闲锁定 → 工具栏消失、解锁后回来
- 系统深浅色切换 → web 主题跟随
- WKWebView 内复制粘贴是否真的走「编辑」菜单
- 真的 `NSOpenPanel` 弹出后用户手动选文件（自测用 `autoImportFile` /
  `autoImageFile` 绕过面板）

---

## 8. 签名三坑

`./macos/release.sh` 出可双击使用的正式版（universal 二进制 + Apple Development
正式签名 + 沙盒 entitlement + hardened runtime），跟 `build.sh` 的差别就是这些。

### 8.1 `release.sh` 的自检清单（任何一项不过就中止）

- universal：`lipo -info` 必须同时报出 `x86_64` 和 `arm64`
- `plutil -lint` 判 `Info.plist` 格式合法（XML 注释里写两个连字符就会截断注释，
  后面的文字变成正文 → App 启动即崩且无日志）
- 关键键齐全：`identifier` / `executable` / `icon` / 分类 UTI / `NSPrincipalClass` …
- 图标在包里且非空（少了就是 Dock 里的通用占位图）
- `dist/index.html` 在包里（少了白屏）
- app 根目录只有 `Contents/`
- 无 `com.apple.quarantine` 标记
- `codesign --verify --deep --strict` 通过

### 8.2 三个签名坑（都实测踩过）

**① entitlements 文件不能放进 app bundle**

```
codesign: In subcomponent: .../Contents/LifeCanvas.entitlements
          code object is not signed at all
```

codesign 会把 bundle 内**每个文件**都当成子组件要求它有签名，而 plist 签不了。
entitlements 只在签名时从源码路径读，**不进 bundle**。

**② 钥匙串里有两张同名证书 → codesign 直接报 ambiguous**

```
Apple Development: <姓名> (<ID>): ambiguous
  (matches "..." and "..." in .../login.keychain-db)
```

→ **必须用 SHA-1 指纹**，不能用证书名。`release.sh` 默认从钥匙串里取指纹并逐个候选
试签（`security find-identity -v -p codesigning` 取 SHA-1，再用 SHA-1 去签）。

**③ 别用 Apple Distribution 做本地包**

那种签名是走 Mac App Store 渠道用的，签出来的包在本机会被 AMFI 拦
（`No matching profile found`）。本地用 **Apple Development + 沙盒 entitlement**。

> ⚠️ 签名失败如果被 `|| true` 吞掉，表现是「看起来签了，其实没有」。
> 所以签完必须再 `codesign --verify --deep --strict` 验一遍。

### 8.3 暂存目录不能以 `.app` 结尾

LaunchServices 会把任何一个完整的 `.app` 注册进去；临时目录删掉后就留下一条**悬空
注册**，还占着同一个 bundle id —— Dock / 启动台会因此解析到系统通用占位图标而不是真
图标。所以暂存区拼的是一个无扩展名的普通目录，最后才 `ditto` 成 `.app`。

---

## 9. 换 bundle id 怎么迁数据

沙盒容器按 bundle id 分目录，换 id = 数据失联。**数据其实能搬**，因为：

- 记录载荷加密，但 **IndexedDB 的元数据表不加密**（`IndexRecords` 的行数 = 记录条数），
  可以用来验证搬没搬对；
- app 用的是自定义 scheme `app://` → **origin 哈希不变**，只有 profile 哈希变。

```bash
OLD=~/Library/Containers/<旧 bundle id>/Data/Library/WebKit/WebsiteData/Default
NEW=~/Library/Containers/<新 bundle id>/Data/Library/WebKit/WebsiteData/Default

# profile 目录 = 含同名子目录的那个（Default 下还有 salt 等散文件）
OLDHASH=$(for d in "$OLD"/*/; do n=$(basename "$d"); [ -d "$d$n" ] && echo "$n"; done | head -1)
NEWHASH=$(for d in "$NEW"/*/; do n=$(basename "$d"); [ -d "$d$n" ] && echo "$n"; done | head -1)

# ⚠️ 层级是 Default/<hash>/<hash>/…，**两层**。少复制一层会静默失败：
#    记录数不变、文件大小不变，看起来"迁过了"其实数据还在旧目录里。
cp -R "$OLD/$OLDHASH/$OLDHASH/." "$NEW/$NEWHASH/$NEWHASH/"

# 验证（两边的行数必须一致）
sqlite3 "$NEW/$NEWHASH/$NEWHASH/IndexedDB/<origin>/IndexedDB.sqlite3" \
  "select count(*) from IndexRecords"
```

**验证是必须的**：光看「文件大小没变」不算迁成功 —— 少复制一层哈希目录时，
记录数不变、文件大小不变，看起来「迁过了」其实数据还在旧目录里。以
`select count(*) from IndexRecords` 的行数为准，并确认 app 重启后仍能读到同样的条数
（没有重建库）。

> ⚠️ macOS **保护沙盒容器目录**，`rm -rf` 和 `mv` 都会被拒
> （`Operation not permitted`）。真要清空，只能删容器**里面**的具体文件
> （如 `IndexedDB.sqlite3`），或者干脆换一个新的 bundle id。
