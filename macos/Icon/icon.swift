/**
 * icon.swift — 人生画布 macOS 图标渲染器
 *
 * 纯 CoreGraphics 矢量绘制，不依赖任何第三方库。
 * 用法：
 *   swift icon.swift <variant> <out.png> [pixels]
 *   swift icon.swift --all <outDir>      # 出全部 variant 的预览
 *
 * 三个概念方向（variant）：
 *   1 = 星图   —— 节点 + 连线（画布本体）
 *   2 = 阶段框 —— 琥珀虚线阶段框 + 框内节点 + 一条穿出框的线
 *   3 = 卡片   —— 层叠节点卡 + 右侧连接点 + 连接线（app 截图的抽象）
 *
 * 坐标系：左上为原点（1024 单位空间），与设计稿一致。
 */

import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// MARK: - 常量

/// master 画布边长（App Store / macOS 图标标准 1024）
let S: CGFloat = 1024
/// 图标主体（squircle）在 1024 画布里的位置：824×824，四周留 100
let BODY = CGRect(x: 100, y: 100, width: 824, height: 824)

// App 配色（与 src/styles.css 同步，改这里就要改那里）
let C_BG_TOP     = "#232833"
let C_BG_BOT     = "#12141a"
let C_ACCENT     = "#e0a458"
let C_CARD       = "#222630"
let C_LINE       = "#2f3542"
let C_DIM        = "#626a79"
// 节点类型色（src/model/types.ts NODE_TYPE_COLOR）
let N_GOAL    = "#d99a4e"
let N_EVENT   = "#7f9bd4"
let N_EMOTION = "#b98ac9"
let N_IDEA    = "#c9a86a"
let N_PERSON  = "#6fae8f"
let N_PLACE   = "#c98a8a"
let N_WORK    = "#d47f9a"
// 线类型色（EDGE_TYPE_COLOR）
let E_SUPPORT  = "#6fae8f"
let E_REPLACE  = "#e0a458"
let E_REFERENCE = "#7f9bd4"
let E_CAUSE    = "#c9a86a"
let E_INSPIRE  = "#b98ac9"
let E_CONFLICT = "#d47f9a"
let E_SEQUENCE = "#8b93a1"

// MARK: - 基础工具

func hex(_ s: String) -> (CGFloat, CGFloat, CGFloat) {
    var t = s
    if t.hasPrefix("#") { t.removeFirst() }
    let v = UInt32(t, radix: 16) ?? 0
    return (CGFloat((v >> 16) & 0xff) / 255,
            CGFloat((v >> 8) & 0xff) / 255,
            CGFloat(v & 0xff) / 255)
}

func cg(_ s: String, _ a: CGFloat = 1) -> CGColor {
    let (r, g, b) = hex(s)
    return CGColor(colorSpace: CGColorSpaceCreateDeviceRGB(), components: [r, g, b, a])!
}

func grad(_ stops: [(CGFloat, CGColor)], _ space: CGColorSpace = CGColorSpaceCreateDeviceRGB()) -> CGGradient? {
    let colors = stops.map { $0.1 } as CFArray
    let locs = stops.map { $0.0 }
    return CGGradient(colorsSpace: space, colors: colors, locations: locs)
}

/// macOS 的连续圆角 squircle。n=5 的超椭圆在 45° 处与圆角矩形几乎重合，
/// 但曲率连续 —— 这才是 Big Sur 之后的 macOS 图标轮廓。
func squirclePath(_ rect: CGRect, n: CGFloat = 5, steps: Int = 900) -> CGPath {
    let p = CGMutablePath()
    let cx = rect.midX, cy = rect.midY
    let a = rect.width / 2, b = rect.height / 2
    let e = 2.0 / n
    for i in 0...steps {
        let t = CGFloat(i) / CGFloat(steps) * 2 * .pi
        let ct = cos(t), st = sin(t)
        let x = cx + a * copysign(pow(abs(ct), e), ct)
        let y = cy + b * copysign(pow(abs(st), e), st)
        if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
    }
    p.closeSubpath()
    return p
}

// MARK: - 光学分级：小尺寸要换画法，不是等比缩小

enum Detail {
    case full    // 1024 / 512：全细节（网格、辉光、全部连线）
    case medium  // 256 / 128：去网格，线加粗
    case low     // 64 / 32 / 16：极简，只留主体结构，线加粗到不消失

    static func forPixels(_ px: Int) -> Detail {
        switch px {
        case 1024, 512: return .full
        case 256, 128: return .medium
        default: return .low
        }
    }
}

struct Node {
    let p: CGPoint
    let r: CGFloat
    let color: String
    var glow: Bool = false
}

struct Edge {
    let a: CGPoint
    let b: CGPoint
    let color: String
    var bend: CGFloat = 0
}

// MARK: - 变体数据

func nodes(for variant: Int, detail: Detail) -> [Node] {
    switch variant {
    case 1: // 星图：一个焦点节点 + 五颗卫星（重心居中，铺满整个画布）
        if detail == .low {
            return [
                Node(p: CGPoint(x: 400, y: 340), r: 88, color: N_GOAL),
                Node(p: CGPoint(x: 655, y: 235), r: 58, color: N_PERSON),
                Node(p: CGPoint(x: 700, y: 490), r: 58, color: N_EVENT),
                Node(p: CGPoint(x: 505, y: 640), r: 58, color: N_EMOTION),
                Node(p: CGPoint(x: 255, y: 520), r: 54, color: N_PLACE),
            ]
        }
        return [
            Node(p: CGPoint(x: 400, y: 330), r: 56, color: N_GOAL, glow: true),
            Node(p: CGPoint(x: 655, y: 235), r: 34, color: N_PERSON),
            Node(p: CGPoint(x: 700, y: 490), r: 38, color: N_EVENT),
            Node(p: CGPoint(x: 505, y: 640), r: 36, color: N_EMOTION),
            Node(p: CGPoint(x: 255, y: 520), r: 30, color: N_PLACE),
            Node(p: CGPoint(x: 640, y: 745), r: 27, color: N_WORK),
        ]
    case 2: // 阶段框：框内一团节点 + 一条线穿出框外
        if detail == .low {
            return [
                Node(p: CGPoint(x: 315, y: 395), r: 82, color: N_GOAL),
                Node(p: CGPoint(x: 550, y: 345), r: 56, color: N_EVENT),
                Node(p: CGPoint(x: 520, y: 590), r: 52, color: N_EMOTION),
                Node(p: CGPoint(x: 300, y: 610), r: 50, color: N_WORK),
                Node(p: CGPoint(x: 845, y: 285), r: 60, color: N_PERSON),
            ]
        }
        return [
            Node(p: CGPoint(x: 315, y: 390), r: 46, color: N_GOAL, glow: true),
            Node(p: CGPoint(x: 550, y: 345), r: 32, color: N_EVENT),
            Node(p: CGPoint(x: 520, y: 590), r: 30, color: N_EMOTION),
            Node(p: CGPoint(x: 300, y: 610), r: 26, color: N_WORK),
            Node(p: CGPoint(x: 845, y: 285), r: 36, color: N_PERSON),
        ]
    case 4: // 混合：阶段框只圈住一段关系，其余节点在框外，线跨过边界
        if detail == .low {
            return [
                Node(p: CGPoint(x: 385, y: 400), r: 80, color: N_GOAL),
                Node(p: CGPoint(x: 605, y: 340), r: 56, color: N_EVENT),
                Node(p: CGPoint(x: 480, y: 620), r: 52, color: N_EMOTION),
                Node(p: CGPoint(x: 255, y: 290), r: 54, color: N_PLACE),
                Node(p: CGPoint(x: 800, y: 640), r: 54, color: N_PERSON),
            ]
        }
        return [
            Node(p: CGPoint(x: 385, y: 400), r: 52, color: N_GOAL, glow: true),
            Node(p: CGPoint(x: 605, y: 340), r: 34, color: N_EVENT),
            Node(p: CGPoint(x: 480, y: 620), r: 32, color: N_EMOTION),
            Node(p: CGPoint(x: 255, y: 290), r: 30, color: N_PLACE),
            Node(p: CGPoint(x: 800, y: 640), r: 32, color: N_PERSON),
        ]
    default:
        return []
    }
}

func edges(for variant: Int, detail: Detail) -> [Edge] {
    switch variant {
    case 1:
        if detail == .low {
            return [
                Edge(a: CGPoint(x: 400, y: 340), b: CGPoint(x: 655, y: 235), color: E_SUPPORT),
                Edge(a: CGPoint(x: 400, y: 340), b: CGPoint(x: 700, y: 490), color: E_REFERENCE),
                Edge(a: CGPoint(x: 400, y: 340), b: CGPoint(x: 505, y: 640), color: E_CAUSE),
                Edge(a: CGPoint(x: 400, y: 340), b: CGPoint(x: 255, y: 520), color: E_INSPIRE),
            ]
        }
        return [
            Edge(a: CGPoint(x: 400, y: 330), b: CGPoint(x: 655, y: 235), color: E_SUPPORT, bend: 26),
            Edge(a: CGPoint(x: 400, y: 330), b: CGPoint(x: 700, y: 490), color: E_REFERENCE, bend: 32),
            Edge(a: CGPoint(x: 400, y: 330), b: CGPoint(x: 505, y: 640), color: E_CAUSE, bend: 26),
            Edge(a: CGPoint(x: 400, y: 330), b: CGPoint(x: 255, y: 520), color: E_INSPIRE, bend: 24),
            Edge(a: CGPoint(x: 655, y: 235), b: CGPoint(x: 700, y: 490), color: E_SEQUENCE, bend: -18),
            Edge(a: CGPoint(x: 505, y: 640), b: CGPoint(x: 640, y: 745), color: E_SEQUENCE, bend: 18),
        ]
    case 2:
        if detail == .low {
            return [
                Edge(a: CGPoint(x: 315, y: 395), b: CGPoint(x: 550, y: 345), color: E_SUPPORT),
                Edge(a: CGPoint(x: 315, y: 395), b: CGPoint(x: 520, y: 590), color: E_CAUSE),
                Edge(a: CGPoint(x: 315, y: 395), b: CGPoint(x: 300, y: 610), color: E_INSPIRE),
                Edge(a: CGPoint(x: 550, y: 345), b: CGPoint(x: 845, y: 285), color: E_REPLACE),
            ]
        }
        return [
            Edge(a: CGPoint(x: 315, y: 390), b: CGPoint(x: 550, y: 345), color: E_SUPPORT, bend: 18),
            Edge(a: CGPoint(x: 315, y: 390), b: CGPoint(x: 520, y: 590), color: E_CAUSE, bend: 18),
            Edge(a: CGPoint(x: 315, y: 390), b: CGPoint(x: 300, y: 610), color: E_INSPIRE, bend: 16),
            Edge(a: CGPoint(x: 550, y: 345), b: CGPoint(x: 845, y: 285), color: E_REPLACE, bend: 14),
        ]
    case 4:
        if detail == .low {
            return [
                Edge(a: CGPoint(x: 385, y: 400), b: CGPoint(x: 605, y: 340), color: E_REFERENCE),
                Edge(a: CGPoint(x: 385, y: 400), b: CGPoint(x: 480, y: 620), color: E_SUPPORT),
                Edge(a: CGPoint(x: 385, y: 400), b: CGPoint(x: 255, y: 290), color: E_INSPIRE),
                Edge(a: CGPoint(x: 480, y: 620), b: CGPoint(x: 800, y: 640), color: E_REPLACE),
            ]
        }
        return [
            Edge(a: CGPoint(x: 385, y: 400), b: CGPoint(x: 605, y: 340), color: E_REFERENCE, bend: 20),
            Edge(a: CGPoint(x: 385, y: 400), b: CGPoint(x: 480, y: 620), color: E_SUPPORT, bend: 20),
            Edge(a: CGPoint(x: 385, y: 400), b: CGPoint(x: 255, y: 290), color: E_INSPIRE, bend: 18),
            Edge(a: CGPoint(x: 480, y: 620), b: CGPoint(x: 800, y: 640), color: E_REPLACE, bend: 16),
        ]
    default:
        return []
    }
}

/// 阶段框（variant 2 / 4 专用）：琥珀虚线 = app 里的「阶段」边界
func stageFrame(variant: Int, detail: Detail) -> CGRect {
    switch (variant, detail) {
    case (2, .low):  return CGRect(x: 165, y: 250, width: 530, height: 470)
    case (2, _):     return CGRect(x: 168, y: 250, width: 545, height: 470)
    case (4, .low):  return CGRect(x: 300, y: 250, width: 400, height: 470)
    default:         return CGRect(x: 310, y: 255, width: 390, height: 455)
    }
}

// MARK: - 绘制

func drawBody(_ ctx: CGContext, detail: Detail) {
    let path = squirclePath(BODY)

    // 投影（macOS 不自带阴影，图标自带）
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -14), blur: 30, color: cg("#000000", 0.40))
    ctx.addPath(path)
    ctx.setFillColor(cg(C_BG_BOT))
    ctx.fillPath()
    ctx.restoreGState()

    // 主体渐变 + 裁切
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()

    if let g = grad([(0, cg(C_BG_TOP)), (1, cg(C_BG_BOT))]) {
        ctx.drawLinearGradient(g,
                               start: CGPoint(x: 150, y: 110),
                               end: CGPoint(x: 880, y: 920),
                               options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }
    // 左上角琥珀环境光
    if let g = grad([(0, cg(C_ACCENT, detail == .low ? 0.0 : 0.16)),
                     (0.55, cg(C_ACCENT, 0.03)),
                     (1, cg(C_ACCENT, 0.0))]) {
        ctx.drawRadialGradient(g,
                               startCenter: CGPoint(x: 300, y: 250), startRadius: 0,
                               endCenter: CGPoint(x: 300, y: 250), endRadius: 620,
                               options: [])
    }
    // 底部压暗，做出厚度
    if let g = grad([(0, cg("#000000", 0.0)), (1, cg("#000000", 0.34))]) {
        ctx.drawLinearGradient(g,
                               start: CGPoint(x: 512, y: 480),
                               end: CGPoint(x: 512, y: 924),
                               options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    }
    ctx.restoreGState()

    // 内壁描边（1px 亮边，给出 macOS 图标的「边缘反光」）
    ctx.saveGState()
    ctx.addPath(path)
    ctx.setStrokeColor(cg("#ffffff", detail == .low ? 0.10 : 0.13))
    ctx.setLineWidth(detail == .low ? 3 : 2)
    ctx.strokePath()
    ctx.restoreGState()

    // 顶部高光
    if detail != .low {
        ctx.saveGState()
        ctx.addPath(path)
        ctx.clip()
        if let g = grad([(0, cg("#ffffff", 0.10)), (1, cg("#ffffff", 0.0))]) {
            ctx.drawLinearGradient(g,
                                   start: CGPoint(x: 512, y: 100),
                                   end: CGPoint(x: 512, y: 420),
                                   options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
        ctx.restoreGState()
    }
}

/// 画布的网点背景（app 里的 canvas dot grid）
func drawDotGrid(_ ctx: CGContext, detail: Detail) {
    guard detail == .full else { return }
    ctx.saveGState()
    ctx.addPath(squirclePath(BODY))
    ctx.clip()
    ctx.setFillColor(cg("#ffffff", 0.055))
    var y: CGFloat = 148
    while y < 900 {
        var x: CGFloat = 148
        while x < 900 {
            ctx.fillEllipse(in: CGRect(x: x - 2.2, y: y - 2.2, width: 4.4, height: 4.4))
            x += 56
        }
        y += 56
    }
    ctx.restoreGState()
}

func drawEdge(_ ctx: CGContext, _ e: Edge, width: CGFloat, alpha: CGFloat) {
    let dx = e.b.x - e.a.x, dy = e.b.y - e.a.y
    let len = max(1, sqrt(dx * dx + dy * dy))
    let cx = (e.a.x + e.b.x) / 2 - dy / len * e.bend
    let cy = (e.a.y + e.b.y) / 2 + dx / len * e.bend
    ctx.beginPath()
    ctx.move(to: e.a)
    ctx.addQuadCurve(to: e.b, control: CGPoint(x: cx, y: cy))
    ctx.setStrokeColor(cg(e.color, alpha))
    ctx.setLineWidth(width)
    ctx.setLineCap(.round)
    ctx.strokePath()
}

func drawNode(_ ctx: CGContext, _ n: Node, detail: Detail) {
    if n.glow && detail != .low {
        if let g = grad([(0, cg(n.color, 0.34)), (0.55, cg(n.color, 0.10)), (1, cg(n.color, 0.0))]) {
            ctx.drawRadialGradient(g,
                                   startCenter: n.p, startRadius: 0,
                                   endCenter: n.p, endRadius: n.r * 2.6,
                                   options: [])
        }
    }
    ctx.setFillColor(cg(n.color))
    ctx.fillEllipse(in: CGRect(x: n.p.x - n.r, y: n.p.y - n.r, width: n.r * 2, height: n.r * 2))
    // 左上高光，让圆点有体积
    ctx.setFillColor(cg("#ffffff", 0.20))
    let hr = n.r * 0.42
    ctx.fillEllipse(in: CGRect(x: n.p.x - n.r * 0.52, y: n.p.y - n.r * 0.60, width: hr * 2, height: hr * 2))
}

/// variant 3：层叠节点卡（抽象自 app 里的画布卡片）
func drawCards(_ ctx: CGContext, detail: Detail) {
    struct Card {
        let rect: CGRect
        let bar: String
        let lines: Int
        let focused: Bool
        let dim: CGFloat
    }
    let cards: [Card]
    if detail == .low {
        cards = [
            Card(rect: CGRect(x: 210, y: 268, width: 560, height: 190), bar: N_EVENT, lines: 2, focused: false, dim: 0.55),
            Card(rect: CGRect(x: 254, y: 418, width: 560, height: 190), bar: N_EMOTION, lines: 2, focused: false, dim: 0.75),
            Card(rect: CGRect(x: 298, y: 568, width: 560, height: 190), bar: N_GOAL, lines: 2, focused: true, dim: 1),
        ]
    } else {
        cards = [
            Card(rect: CGRect(x: 186, y: 232, width: 600, height: 196), bar: N_EVENT, lines: 2, focused: false, dim: 0.55),
            Card(rect: CGRect(x: 236, y: 396, width: 600, height: 196), bar: N_EMOTION, lines: 2, focused: false, dim: 0.78),
            Card(rect: CGRect(x: 286, y: 560, width: 600, height: 196), bar: N_GOAL, lines: 2, focused: true, dim: 1),
        ]
    }
    let r: CGFloat = detail == .low ? 40 : 34
    for c in cards {
        // 卡面
        let p = CGPath(roundedRect: c.rect, cornerWidth: r, cornerHeight: r, transform: nil)
        ctx.saveGState()
        ctx.addPath(p)
        ctx.setFillColor(cg(C_CARD, c.dim))
        ctx.fillPath()
        ctx.setStrokeColor(cg(C_LINE, c.dim * 0.9))
        ctx.setLineWidth(detail == .low ? 5 : 3)
        ctx.strokePath()
        ctx.restoreGState()

        // 左侧类型色条（app 里节点卡的彩色左边条）
        let barW: CGFloat = detail == .low ? 22 : 16
        let barRect = CGRect(x: c.rect.minX + (detail == .low ? 26 : 22),
                             y: c.rect.minY + (detail == .low ? 34 : 28),
                             width: barW, height: c.rect.height - (detail == .low ? 68 : 56))
        ctx.saveGState()
        ctx.addPath(CGPath(roundedRect: barRect, cornerWidth: barW / 2, cornerHeight: barW / 2, transform: nil))
        ctx.setFillColor(cg(c.bar, c.dim))
        ctx.fillPath()
        ctx.restoreGState()

        // 文本占位条
        let tx = barRect.maxX + 28
        let tw = c.rect.maxX - tx - 30
        for i in 0..<c.lines {
            let h: CGFloat = detail == .low ? 26 : 22
            let y = c.rect.minY + 56 + CGFloat(i) * (h + 18)
            let w = i == 0 ? tw * 0.78 : tw * 0.52
            let rr = CGPath(roundedRect: CGRect(x: tx, y: y, width: w, height: h),
                            cornerWidth: h / 2, cornerHeight: h / 2, transform: nil)
            ctx.setFillColor(cg("#ffffff", (i == 0 ? 0.30 : 0.16) * c.dim))
            ctx.addPath(rr)
            ctx.fillPath()
        }

        // 右侧连接点（app 里节点卡右缘的圆点）
        let dotR: CGFloat = detail == .low ? 34 : 28
        let dp = CGPoint(x: c.rect.maxX, y: c.rect.midY)
        ctx.setFillColor(cg(c.bar, c.dim))
        ctx.fillEllipse(in: CGRect(x: dp.x - dotR, y: dp.y - dotR, width: dotR * 2, height: dotR * 2))

        // 聚焦卡的琥珀高亮环
        if c.focused {
            let ring = CGPath(roundedRect: c.rect.insetBy(dx: -12, dy: -12),
                              cornerWidth: r + 12, cornerHeight: r + 12, transform: nil)
            ctx.setStrokeColor(cg(C_ACCENT, 0.85))
            ctx.setLineWidth(detail == .low ? 9 : 6)
            ctx.setLineDash(phase: 0, lengths: [28, 20])
            ctx.addPath(ring)
            ctx.strokePath()
            ctx.setLineDash(phase: 0, lengths: [])
        }
    }
}

// MARK: - 合成

func render(variant: Int, pixels: Int) -> CGImage? {
    let detail = Detail.forPixels(pixels)
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(data: nil,
                              width: pixels, height: pixels,
                              bitsPerComponent: 8, bytesPerRow: 0,
                              space: cs,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }

    // 翻成左上原点
    ctx.translateBy(x: 0, y: CGFloat(pixels))
    ctx.scaleBy(x: 1, y: -1)
    let s = CGFloat(pixels) / S
    ctx.scaleBy(x: s, y: s)
    ctx.setAllowsAntialiasing(true)
    ctx.interpolationQuality = .high

    drawBody(ctx, detail: detail)
    drawDotGrid(ctx, detail: detail)

    switch variant {
    case 1, 2, 4:
        let stroke: CGFloat = detail == .low ? 22 : (detail == .medium ? 9 : 6)
        let alpha: CGFloat = detail == .low ? 0.92 : 0.62
        if variant == 2 || variant == 4 {
            // 阶段框画在连线下面
            let fr = stageFrame(variant: variant, detail: detail)
            let fp = CGPath(roundedRect: fr,
                            cornerWidth: detail == .low ? 60 : 50,
                            cornerHeight: detail == .low ? 60 : 50,
                            transform: nil)
            ctx.setStrokeColor(cg(C_ACCENT, detail == .low ? 0.95 : 0.88))
            ctx.setLineWidth(detail == .low ? 16 : 9)
            ctx.setLineDash(phase: 0, lengths: detail == .low ? [54, 38] : [30, 22])
            ctx.addPath(fp)
            ctx.strokePath()
            ctx.setLineDash(phase: 0, lengths: [])
        }
        for e in edges(for: variant, detail: detail) { drawEdge(ctx, e, width: stroke, alpha: alpha) }
        for n in nodes(for: variant, detail: detail) { drawNode(ctx, n, detail: detail) }
    case 3:
        drawCards(ctx, detail: detail)
    default:
        break
    }

    return ctx.makeImage()
}

func writePNG(_ img: CGImage, to path: String) {
    let url = URL(fileURLWithPath: path)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        print("cannot create destination \(path)"); return
    }
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
}

// MARK: - CLI

let args = CommandLine.arguments
if args.count >= 3 && args[1] == "--all" {
    let outDir = args[2]
    try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
    for v in [1, 2, 3, 4] {
        for px in [1024, 512, 256, 128, 64, 32, 16] {
            guard let img = render(variant: v, pixels: px) else { continue }
            writePNG(img, to: "\(outDir)/v\(v)-\(px).png")
        }
    }
    print("all variants -> \(outDir)")
} else if args.count >= 3 {
    let v = Int(args[1]) ?? 1
    let out = args[2]
    let px = args.count >= 4 ? (Int(args[3]) ?? 1024) : 1024
    if let img = render(variant: v, pixels: px) {
        writePNG(img, to: out)
        print("wrote \(out) (\(px)px, variant \(v))")
    }
}
