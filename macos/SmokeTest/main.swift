//
//  go/no-go 冒烟测试
//
//  目标：回答一个问题 —— 把 life-canvas 的 dist/ 装进 WKWebView 后，
//  存储层和加密层依赖的浏览器能力是否还在。
//
//  判定标准（三个都必须 true，否则方案要改）：
//    indexedDB     —— Dexie 的唯一存储通道
//    crypto.subtle —— PBKDF2 + AES-GCM，缺了整个加密层静默崩
//    Worker        —— 搜索索引（module worker）
//
//  另外必须看 isSecureContext：crypto.subtle 只在 secure context 暴露，
//  自定义 scheme（app://）按规范不算 —— 这是本测试最可能翻车的点。
//
//  一次性产物，验证完即可删。用 macos/SmokeTest/run.sh 编译运行。
//

import Cocoa
import WebKit

// MARK: - 自定义 scheme 处理器
// 从磁盘 dist/ 提供资源。不用 file:// 的原因：origin 不透明，
// IndexedDB / module Worker 在不透明 origin 下会失败。

final class DistSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL

    init(root: URL) { self.root = root }

    func webView(_ webView: WKWebView,
                 start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let fileURL = root.appendingPathComponent(path)

        // 防目录穿越
        guard fileURL.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path),
              let data = try? Data(contentsOf: fileURL) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        // 注意：mimeType 必须是裸 MIME，不能带 "; charset=utf-8"。
        // Foundation 原样存这串，WebKit 按精确类型查表 —— 带参数就查不到，
        // 页面会被当成纯文本渲染成 <pre>（实测踩过）。
        // 字符集走下面 textEncodingName 单独传。
        let mime: String
        switch fileURL.pathExtension {
        case "html": mime = "text/html"
        case "js", "mjs": mime = "text/javascript"
        case "css":  mime = "text/css"
        case "svg":  mime = "image/svg+xml"
        case "json": mime = "application/json"
        case "png":  mime = "image/png"
        case "jpg", "jpeg": mime = "image/jpeg"
        case "woff2": mime = "font/woff2"
        default:     mime = "application/octet-stream"
        }

        let response = URLResponse(url: url,
                                   mimeType: mime,
                                   expectedContentLength: data.count,
                                   textEncodingName: "utf-8")
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

// MARK: - 探测

/// 在页面里跑，返回一行 JSON 字符串
private let PROBE_JS = """
JSON.stringify({
  isSecureContext: window.isSecureContext,
  indexedDB: typeof indexedDB !== 'undefined' && indexedDB !== null,
  subtle: !!(window.crypto && window.crypto.subtle),
  subtleDigest: !!(window.crypto && window.crypto.subtle && window.crypto.subtle.digest),
  Worker: typeof Worker !== 'undefined',
  location: String(location.href),
  origin: String(location.origin)
})
"""

/// 更进一步：真的建一次 IndexedDB 库 + 真的跑一次 PBKDF2。
/// "typeof 存在" 不等于 "能用" —— IndexedDB.open 在不透明 origin 下
/// 可能存在但不 resolve，subtle 存在但 importKey 抛错。
///
/// 注意：evaluateJavaScript 不会 await Promise，所以这里不能直接 return。
/// 改成把结果写进 window.__probe，由 Swift 侧轮询取。
private let DEEP_PROBE_JS = """
(() => {
  window.__probe = null;
  const out = { idbOpen: false, idbWrite: false, pbkdf2: false, worker: false, errors: [] };

  (async () => {
    try {
      const dbs = await Promise.race([
        indexedDB.databases(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('databases() timeout')), 3000))
      ]);
      out.idbListOk = Array.isArray(dbs);
    } catch (e) { out.errors.push('databases(): ' + e.message); }

    try {
      const db = await Promise.race([
        new Promise((res, rej) => {
          const req = indexedDB.open('smoke-test-db', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('kv');
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('open timeout')), 5000))
      ]);
      out.idbOpen = true;
      await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put('hello', 'k');
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
      out.idbWrite = true;
    } catch (e) { out.errors.push('idb: ' + e.message); }

    try {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', enc.encode('pw'),
        'PBKDF2', false, ['deriveKey']);
      await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: crypto.getRandomValues(new Uint8Array(16)),
          iterations: 1000, hash: 'SHA-256' },
        key,
        { name: 'AES-GCM', length: 256 },
        false, ['encrypt', 'decrypt']);
      out.pbkdf2 = true;
    } catch (e) { out.errors.push('pbkdf2: ' + e.message); }

    try {
      const src = 'self.onmessage=e=>self.postMessage("worker-ok:"+e.data)';
      const blob = new Blob([src], { type: 'text/javascript' });
      const w = new Worker(URL.createObjectURL(blob));
      out.worker = await Promise.race([
        new Promise(res => { w.onmessage = e => res(e.data === 'worker-ok:ping'); }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('worker timeout')), 5000))
      ]);
      w.terminate();
    } catch (e) { out.errors.push('worker: ' + e.message); }

    window.__probe = JSON.stringify(out);
  })().catch(e => {
    out.errors.push('uncaught: ' + e.message);
    window.__probe = JSON.stringify(out);
  });

  return 'started';
})()
"""

/// 轮询读取 window.__probe
private let READ_PROBE_JS = "window.__probe"

// MARK: - 诊断
//
// 上一轮 REAL 探测报 canvas:missing / dbVersion:1 —— 说明应用没 boot。
// 但静态 HTML 里的 #cv 都不在，说明问题出在更前面（文档没解析对，或脚本
// 加载失败）。这里把"到底拿到了什么"摊开：文档状态 + 实际抓到哪些资源 +
// 所有 console 报错和未捕获异常。
//
// console 必须在 document-start 注入才拦得住模块求值期的报错。

private let DIAG_HOOK_JS = """
window.__diag = { logs: [], errors: [] };
const push = (k, a) => window.__diag[k].push(
  Array.from(a).map(x => {
    try { return typeof x === 'object' ? JSON.stringify(x) : String(x); }
    catch (e) { return String(x); }
  }).join(' ')
);
for (const level of ['log', 'warn', 'error', 'info']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { push(level === 'error' ? 'errors' : 'logs', a); orig(...a); };
}
window.addEventListener('error', e => {
  window.__diag.errors.push(
    'onerror: ' + (e.message || '?') + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0)
  );
});
window.addEventListener('unhandledrejection', e => {
  window.__diag.errors.push('unhandledrejection: ' + (e.reason && (e.reason.message || e.reason)));
});
"""

private let DIAG_REPORT_JS = """
(() => {
  window.__diagReport = null;
  (async () => {
    const out = {
      readyState: document.readyState,
      title: document.title,
      bodyLen: document.body ? document.body.innerHTML.length : -1,
      bodyHead: document.body ? document.body.innerHTML.slice(0, 400) : '(no body)',
      scripts: Array.from(document.scripts).map(s => s.type + ' ' + (s.src || 'inline')),
      resources: performance.getEntriesByType('resource').map(r => r.name)
    };
    // 给 load 事件和异步 boot 一点时间
    await new Promise(r => setTimeout(r, 1500));
    out.diag = window.__diag;
    window.__diagReport = JSON.stringify(out);
  })();
  return 'started';
})()
"""

// MARK: - 真实应用探测
//
// 上面两项只证明"能力存在"。真正要验的是：life-canvas 本体在 WKWebView 里
// 能不能跑起来、画出来、落库。
//
//  1. canvas 是否真的画了东西（不是 0 像素的空白）
//  2. Dexie 库 life-canvas 是否真的建成，版本 / store 列表对不对
//  3. app 自己的 module worker（不是 blob）有没有被 fetch
//  4. 跨启动持久化：phase1 写入 → 退出 → phase2 读回
//
// 同样因为 Promise 不被 await，结果写进 window.__probe 轮询取。

private let REAL_PROBE_JS = """
(() => {
  window.__probe = null;
  const out = { errors: [] };

  (async () => {
    // 1. 画布
    try {
      const cv = document.querySelector('#cv');
      if (!cv) {
        out.canvas = 'missing';
      } else {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let painted = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) painted++;
        out.canvas = cv.width + 'x' + cv.height;
        out.canvasPaintedPx = painted;
      }
    } catch (e) { out.errors.push('canvas: ' + e.message); }

    // 2. 真实 worker 有没有被 fetch（SearchIndex 是字段初始化器，boot 时必建）
    try {
      out.workerFetched = performance.getEntriesByType('resource')
        .map(r => r.name).filter(n => n.includes('worker'));
    } catch (e) { out.errors.push('perf: ' + e.message); }

    // 3. 打开真库看结构
    try {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('life-canvas');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      window.__db = db;
      out.stores = Array.from(db.objectStoreNames);
      out.dbVersion = db.version;
    } catch (e) { out.errors.push('open life-canvas: ' + e.message); }

    window.__probe = JSON.stringify(out);
  })().catch(e => {
    out.errors.push('uncaught: ' + e.message);
    window.__probe = JSON.stringify(out);
  });

  return 'started';
})()
"""

/// phase 1：往真库的 meta 表写一个带随机值的标记
/// （schema 是 `meta: 'key'`，keyPath 内联在 value 上，不能传独立 key）
private let WRITE_MARKER_JS = """
(() => {
  window.__probe = null;
  const stamp = 'MARK-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const tx = window.__db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key: 'persist-probe', value: stamp });
  tx.oncomplete = () => window.__probe = JSON.stringify({ written: stamp });
  tx.onerror = () => window.__probe = JSON.stringify({ writeErr: String(tx.error) });
  tx.onabort = () => window.__probe = JSON.stringify({ writeErr: 'aborted' });
  return 'started';
})()
"""

/// phase 2：把标记读回来。读到 = 数据跨启动存活
private let READ_MARKER_JS = """
(() => {
  window.__probe = null;
  const tx = window.__db.transaction('meta', 'readonly');
  const r = tx.objectStore('meta').get('persist-probe');
  r.onsuccess = () => window.__probe = JSON.stringify({ found: r.result ? r.result.value : null });
  r.onerror = () => window.__probe = JSON.stringify({ readErr: String(r.error) });
  return 'started';
})()
"""

/// 真实 module worker 探测。
///
/// DEEP 探测里 blob URL worker 超时了，但 life-canvas 不用 blob —— 它是
/// `new Worker(new URL('./indexer.worker.ts', import.meta.url), {type:'module'})`，
/// 构建后落到 assets/indexer.worker-<hash>.js，由自定义 scheme 提供。
/// 这两者走的加载路径完全不同，blob 的结论不能套用到它身上，必须单独验。
///
/// 文件名带 hash，从磁盘目录里扫出来拼进 URL。
private func realWorkerURL(root: URL, pageURL: URL?) -> String? {
    let assets = root.appendingPathComponent("assets")
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: assets.path) else {
        return nil
    }
    guard let hit = names.first(where: { $0.hasPrefix("indexer.worker-") && $0.hasSuffix(".js") })
    else { return nil }
    // 页面实际 origin：走自定义 scheme 时是 app://local，走真实 origin 时取传入的
    if let page = pageURL {
        guard let base = URL(string: "/assets/\(hit)", relativeTo: page) else { return nil }
        return base.absoluteURL.absoluteString
    }
    return "app://local/assets/\(hit)"
}

/// 把 URL 安全地嵌进 JS 字符串字面量
private func jsLiteral(_ s: String) -> String {
    var out = "\""
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        default:
            if ch.value < 0x20 {
                out += String(format: "\\u%04x", ch.value)
            } else {
                out.unicodeScalars.append(ch)
            }
        }
    }
    return out + "\""
}

// MARK: - 应用

final class Probe: NSObject, WKNavigationDelegate {
    private var webView: WKWebView!
    private let root: URL
    private let phase: Int
    private let loadURL: URL?

    init(root: URL, phase: Int, loadURL: URL?) {
        self.root = root
        self.phase = phase
        self.loadURL = loadURL
    }

    func start() {
        let config = WKWebViewConfiguration()
        // 默认走自定义 scheme；传了 loadURL 就改走真实 origin（见 worker A/B）
        if loadURL == nil {
            // 关键：注册自定义 scheme，避开 file:// 的不透明 origin
            config.setURLSchemeHandler(DistSchemeHandler(root: root), forURLScheme: "app")
        }

        // 诊断钩子必须 document-start 注入，否则拦不住模块求值期的报错
        let hook = WKUserScript(source: DIAG_HOOK_JS,
                                injectionTime: .atDocumentStart,
                                forMainFrameOnly: true)
        config.userContentController.addUserScript(hook)

        // 不开开发者工具，但保留 JS 注入
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 600),
                            configuration: config)
        web.navigationDelegate = self
        webView = web

        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
                           styleMask: [.titled],
                           backing: .buffered, defer: false)
        win.contentView = web
        win.title = "life-canvas smoke test (phase \(phase))"
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        web.load(URLRequest(url: loadURL ?? URL(string: "app://local/index.html")!))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 给页面一点时间跑 boot（db.open + 读 meta + 建 SearchIndex）
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { self.runProbe() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("FAIL|导航失败|\(error.localizedDescription)")
        exit(1)
    }

    func webView(_ webView: WKWebView,
                 didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        print("FAIL|页面加载失败|\(error.localizedDescription)")
        exit(1)
    }

    private func runProbe() {
        webView.evaluateJavaScript(PROBE_JS) { shallow, err in
            if let err {
                print("FAIL|浅层探测异常|\(err.localizedDescription)")
                exit(1)
            }
            print("SHALLOW|\(shallow ?? "null")")

            self.webView.evaluateJavaScript(DIAG_REPORT_JS) { _, err0 in
                if let err0 {
                    print("FAIL|诊断启动异常|\(err0.localizedDescription)")
                    exit(1)
                }
                self.poll("DIAG", "window.__diagReport", label: "诊断") { [weak self] in
                    self?.runDeepAndReal()
                }
            }
        }
    }

    private func runDeepAndReal() {
        webView.evaluateJavaScript(DEEP_PROBE_JS) { _, err2 in
            if let err2 {
                print("FAIL|深层探测启动异常|\(err2.localizedDescription)")
                exit(2)
            }
            self.poll("DEEP", READ_PROBE_JS, label: "深层探测") { [weak self] in
                self?.runRealProbe()
            }
        }
    }

    private func runRealProbe() {
        webView.evaluateJavaScript(REAL_PROBE_JS) { _, err in
            if let err {
                print("FAIL|真实探测启动异常|\(err.localizedDescription)")
                exit(3)
            }
            self.poll("REAL", READ_PROBE_JS, label: "真实探测") { [weak self] in
                self?.runWorkerProbeThenPersist()
            }
        }
    }

    /// 先验真实 worker，再做持久化标记。
    /// worker 失败不该阻断持久化判定，所以失败也继续往下走。
    ///
    /// 一次跑三种，区分开"scheme 根本不提供 worker"和"只有 module 型不行"：
    ///   fetch   —— 同一 URL 用 fetch 取，确认 scheme 确实把这个文件发出来了
    ///   classic —— 不带 type:'module' 的 worker
    ///   module  —— 应用真正用的形态
    private func runWorkerProbeThenPersist() {
        guard let url = realWorkerURL(root: root, pageURL: loadURL) else {
            print("WORKER|{\"skipped\":\"在 dist/assets 下没找到 indexer.worker-*.js\"}")
            return persistStep()
        }

        let js = """
        (() => {
          window.__probe = null;
          const out = {};
          const U = \(jsLiteral(url));
          let pending = 3;
          const settle = () => { if (--pending === 0) window.__probe = JSON.stringify(out); };

          fetch(U)
            .then(r => r.text())
            .then(t => { out.fetchOk = true; out.fetchBytes = t.length; out.fetchHead = t.slice(0, 60); })
            .catch(e => { out.fetchOk = false; out.fetchErr = String(e); })
            .finally(settle);

          // 注意：indexer.worker 没有启动消息，只在收到 onmessage 后才回。
          // 被动等 onmessage 必然超时 —— 必须先发一条再加 doc 的消息问它。
          const attempt = (key, opts) => {
            let w;
            try { w = new Worker(U, opts); }
            catch (e) { out[key] = 'ctorErr ' + e; settle(); return; }
            const to = setTimeout(() => { out[key] = 'timeout(no reply)'; settle(); }, 4000);
            w.onerror = e => {
              clearTimeout(to);
              out[key] = 'onerror ' + (e.message || '(no msg)') +
                         ' @' + (e.filename || '?') + ':' + (e.lineno || 0);
              settle();
            };
            w.onmessage = e => {
              clearTimeout(to);
              out[key] = 'reply ' + JSON.stringify(e.data);
              settle();
            };
            w.postMessage({ t: 'addAll', docs: [{
              id: 'probe', title: '人生画布 smoke', content: '',
              tags: [], reasons: []
            }] });
          };
          attempt('classic', undefined);
          attempt('module', { type: 'module' });

          return 'started';
        })()
        """

        webView.evaluateJavaScript(js) { _, err in
            if let err {
                print("WORKER|{\"startErr\":\"\(err.localizedDescription)\"}")
                return self.persistStep()
            }
            self.poll("WORKER", READ_PROBE_JS, label: "worker 探测") { [weak self] in
                self?.persistStep()
            }
        }
    }

    private func persistStep() {
        // phase 1 写标记，phase 2 读标记
        let js = phase == 1 ? WRITE_MARKER_JS : READ_MARKER_JS
        let label = phase == 1 ? "PERSIST_WRITE" : "PERSIST_READ"
        webView.evaluateJavaScript(js) { _, err2 in
            if let err2 {
                print("FAIL|\(label) 启动异常|\(err2.localizedDescription)")
                exit(4)
            }
            self.poll(label, READ_PROBE_JS, label: label) { [weak self] in
                self?.finish()
            }
        }
    }

    /// evaluateJavaScript 不 await Promise，所以异步探测只能轮询取结果。
    private func poll(_ tag: String, _ js: String, label: String, then: @escaping () -> Void) {
        poll(tag, js, label: label, triesLeft: 40, then: then)
    }

    private func poll(_ tag: String, _ js: String, label: String,
                      triesLeft: Int, then: @escaping () -> Void) {
        guard triesLeft > 0 else {
            print("FAIL|\(label)超时|40 × 300ms 内未返回")
            exit(2)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            self.webView.evaluateJavaScript(js) { value, _ in
                if let s = value as? String, !s.isEmpty, s != "null" {
                    print("\(tag)|\(s)")
                    then()
                } else {
                    self.poll(tag, js, label: label, triesLeft: triesLeft - 1, then: then)
                }
            }
        }
    }

    private func finish() {
        // 结果已经打到 stdout，等久一点让 stdout 刷完
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            exit(0)
        }
    }
}

// MARK: - 入口

let args = CommandLine.arguments
let distRoot = URL(fileURLWithPath: args.count > 1 ? args[1] : "dist").standardizedFileURL
let phase = args.count > 2 ? (Int(args[2]) ?? 1) : 1
// 第 4 个参数：直接加载这个 URL 而不是走 app:// —— 用来 A/B 真实 origin 下的 worker
let pageURL = args.count > 3 ? URL(string: args[3]) : nil

guard FileManager.default.fileExists(atPath: distRoot.appendingPathComponent("index.html").path) else {
    print("FAIL|找不到 dist/index.html|先跑 npm run build，目标 \(distRoot.path)")
    exit(3)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let probe = Probe(root: distRoot, phase: phase, loadURL: pageURL)
probe.start()
app.run()