//
//  SchemeHandler.swift
//  life-canvas macOS 外壳
//
//  从 app:// 提供 dist/ 静态资源。不用 file:// 的原因：file:// 下 origin 不透明，
//  IndexedDB / Worker 全部不可用（实测）。
//
//  ⚠️ mimeType 必须是裸 MIME，不能带 "; charset=utf-8"。
//  Foundation 原样存这串，WebKit 按精确类型查表 —— 带参数查不到就把页面当纯文本
//  渲染，HTML 源码被转义后塞进 <pre>。不报任何错，页面就是全白。
//  字符集走 textEncodingName 单独传。这是冒烟测试踩过的坑，别"优化"回去。
//

import Foundation
import WebKit

final class SchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL

    init(root: URL) { self.root = root }

    private static let mime: [String: String] = [
        "html": "text/html",
        "js": "text/javascript",
        "mjs": "text/javascript",
        "css": "text/css",
        "svg": "image/svg+xml",
        "json": "application/json",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "woff": "font/woff",
        "woff2": "font/woff2",
        "ttf": "font/ttf",
        "map": "application/json",
        "txt": "text/plain",
        "webmanifest": "application/manifest+json",
    ]

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        // 去掉查询串（?stress=N 之类）
        if let idx = path.firstIndex(of: "?") { path = String(path[path.startIndex..<idx]) }

        let fileURL = root.appendingPathComponent(path).standardizedFileURL

        // 防目录穿越：standardized 之后必须仍在 root 之内
        let insideRoot = fileURL.path.hasPrefix(root.standardizedFileURL.path + "/")
        guard insideRoot, FileManager.default.fileExists(atPath: fileURL.path) else {
            // SPA 回退：未知路径交给 index.html，而不是 404
            let fallback = root.appendingPathComponent("index.html")
            guard let html = try? Data(contentsOf: fallback) else {
                urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
                return
            }
            urlSchemeTask.didReceive(Self.response(for: url, servedAt: fallback, data: html))
            urlSchemeTask.didReceive(html)
            urlSchemeTask.didFinish()
            return
        }

        // 目录 → 目录下的 index.html
        var serveURL = fileURL
        if let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
           attrs[.type] as? FileAttributeType == .typeDirectory {
            serveURL = fileURL.appendingPathComponent("index.html")
        }

        guard let data = try? Data(contentsOf: serveURL) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        urlSchemeTask.didReceive(Self.response(for: url, servedAt: serveURL, data: data))
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    /// ⚠️ url 必须是**请求**的 URL（app://…），不是磁盘上的 file:// 路径。
    /// 传 file:// 时 WebKit 认为响应和请求对不上，直接丢弃 —— 不回调 didFail，
    /// 导航既不提交也不报错，页面就停在 about:blank，而且再也不会去取 assets。
    private static func response(for requestURL: URL, servedAt fileURL: URL, data: Data) -> URLResponse {
        let ext = fileURL.pathExtension.lowercased()
        return URLResponse(
            url: requestURL,
            mimeType: mime[ext] ?? "application/octet-stream",
            expectedContentLength: data.count,
            textEncodingName: "utf-8"
        )
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}