//
//  Bridge.swift
//  JS ↔ 原生 的双向通道。
//
//    web → 原生   window.webkit.messageHandlers.shell.postMessage({...})
//    原生 → web   window.__lcShell.cmd({...})
//
//  消息一律是 { type: String, ...payload }。
//
//  两处必须小心的：
//  1. WKUserContentController 对 message handler 是**强引用**，直接注册 self
//     会形成永久循环引用，webView 永远不释放。外面套一层 weak 代理。
//  2. web 模块还没求值完时 window.__lcShell 还不存在，首条命令会静默丢掉。
//     所以 web 端 boot 完成会发一条 'ready'，在此之前原生侧的消息进队列缓存。
//

import WebKit

protocol BridgeDelegate: AnyObject {
    /// web 发来一条消息
    func bridge(_ bridge: Bridge, didReceive type: String, payload: [String: Any])
}

/// 弱引用代理：只为了让 WKUserContentController 不持有 Bridge。
private final class WeakProxy: NSObject, WKScriptMessageHandler {
    weak var target: Bridge?
    init(_ t: Bridge) { target = t }

    func userContentController(_ c: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let target,
              let dict = message.body as? [String: Any],
              let type = dict["type"] as? String else { return }
        var payload = dict
        payload.removeValue(forKey: "type")
        target.receive(type: type, payload: payload)
    }
}

final class Bridge: NSObject {
    weak var delegate: BridgeDelegate?
    private weak var webView: WKWebView?
    /// 必须 lazy：WeakProxy(self) 在 init 里会构成 "self used before super.init"
    private lazy var proxy = WeakProxy(self)
    private var webReady = false
    /// web ready 之前攒下的命令
    private var pending: [(String, [String: Any])] = []
    /// web→原生 收到过的消息类型。SelfTest 断言回执走这条路。
    /// 注意它和 native→web 是**两条不同的通道**：原生发出去的东西
    /// 走 window.__lcShell.cmd，网页那边 spy 不到；网页发过来的才走这里。
    private(set) var receivedTypes: [String] = []

    func attach(to webView: WKWebView) {
        self.webView = webView
        webView.configuration.userContentController.add(proxy, name: "shell")
    }

    /// 原生 → web。web 还没 ready 就先缓存，ready 后一次性补发。
    func send(_ type: String, _ payload: [String: Any] = [:]) {
        guard webReady else {
            // 同一状态的重复消息只留最后一条，别把队列灌爆
            if let i = pending.firstIndex(where: { $0.0 == type }) {
                pending[i] = (type, payload)
            } else {
                pending.append((type, payload))
            }
            return
        }
        dispatch(type, payload)
    }

    fileprivate func onWebReady() {
        webReady = true
        let queue = pending
        pending = []
        for (type, payload) in queue { dispatch(type, payload) }
        onReady?()
    }

    /// web 发来 ready 之后回调一次。SelfTest 用它当起跑线。
    var onReady: (() -> Void)?

    /// 入口：'ready' 由 Bridge 自己吃掉（用来开闸放行队列），
    /// 其余消息透传给 delegate。
    fileprivate func receive(type: String, payload: [String: Any]) {
        receivedTypes.append(type)
        if type == "ready" { onWebReady() }
        delegate?.bridge(self, didReceive: type, payload: payload)
    }

    private func dispatch(_ type: String, _ payload: [String: Any]) {
        guard let webView else { return }
        var msg = payload
        msg["type"] = type
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__lcShell && window.__lcShell.cmd(\(json))") { _, _ in }
    }
}