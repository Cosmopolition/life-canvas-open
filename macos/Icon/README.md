# LifeCanvas 图标

macOS 应用图标。成品是 `LifeCanvas.icns`，由 `build.sh` 打进 `LifeCanvas.app`。

## 成品长什么样

**琥珀主线穿出画框**。

一条暖琥珀色的曲线从图标左下贯穿到右上，在两端被图标的边界**切断**——
线是断的，意味着它继续延伸到画框之外。线上串着四颗带环的小节点
（鼠尾草绿 / 淡蓝 / 丁香紫 / 灰玫瑰），另有几根细线从主线上分岔出去，
通向更小、更暗的节点。背景是深炭色画布，点阵网格，几条极淡的横带
（时间 / 阶段带）。

## 为什么是这个

出自 `docs/ARCHITECTURE.md` 第 1 节的产品内核：

> 普通画布里，画布是主对象，节点是画布上的图形。
> 人生画布里，**图谱是主对象，画布只是「当前这个面」的一张视图**。

所以图标不该画「一团节点和线」（那是所有思维导图 App 的通用答案），
而该表达「**聚光的焦点 + 延伸出画面的关系**」：

- **线穿出画框** = 画布只是这一切面，图谱比它大
- **带环的小节点** = app 里节点的真实画法（点 + 环形高亮），不是大色块
- **淡横带** = 时间轴视图里的「面」（人生 / 阶段 / 主线）
- **琥珀主线** = 时间轴里那条「取代链」曲线，被取代的目标串成一条线

配色全部取自 app 源码，不是另起一套：
`src/styles.css` 的 `--bg #16181d` / `--accent #e0a458` / `--card #222630`，
`src/model/types.ts` 的 `NODE_TYPE_COLOR`（节点色）与 `EDGE_TYPE_COLOR`（线色）。

## 管线

```
source/ai-H-threads.png   ← 图像模型出的 2048 稿（提示词见 prompts.md）
        │
        │ compose_icon.py
        ▼
preview/master-1024.png  ← 1024 master，已套精确 macOS squircle
        │
        │ make_iconset.py + iconutil
        ▼
LifeCanvas.icns          ← 10 个尺寸，build.sh 直接打进 .app
```

一次重建：

```bash
cd macos/Icon && ./make_icon.sh
```

源图只留了采用的那一张（`source/ai-H-threads.png`）；其余方向的源图已删，
但 `prompts.md` 里存着全部提示词，随时可以重新生成。
`source/ai-H-threads.png` 存的是**裁掉外围空白后的版本**（主体像素未动，
裁剪不改变合成结果——已用 SHA1 验证过 master 可复现）。

### compose_icon.py 在修什么

图像模型出的稿有三个必须修的毛病，不修就是垃圾图标：

1. **「透明背景」被画成了棋盘格**并烤进像素（输出是 RGB，没有 alpha 通道）。
   → 按亮度抠主体（棋盘格是浅灰 211/251，主体是深色），填掉内部洞。
2. **形状外缘一圈浅灰描边/倒角**，形状是 iOS 风格的大圆角。
   → 用「低饱和 + 中等亮度」识别中性灰描边并剔除；饱和度阈值收紧到
   `max-min < 14`，才不会误伤顶部那些偏蓝的浅色渐变。
3. **轮廓不是 macOS 的连续圆角 squircle**。
   → 重新套用精确形状：1024 画布 / 824 主体 / 四周留 100 / n=5 超椭圆
   （n=5 在 45° 处与圆角矩形几乎重合，但曲率连续，这才是 Big Sur 之后的形状），
   再补投影、顶部边缘高光、1px 内描边。

另外处理了两个边缘问题：
形状边缘的点阵被阈值切成梳齿状碎块（形态学闭运算→开运算→取最大连通域）；
模型画的圆角比 macOS 的圆，四角缺料由极坐标径向外推补齐。

### 出图提示词

`prompts.md` 里存着全部 8 条提示词原文。共同结构是三段式：

> Professional macOS app icon design, square canvas, straight-on flat front view, no mockup.
> Icon shape is the modern macOS squircle … everything outside the squircle is fully transparent.
> The squircle body is a deep charcoal near-black gradient from #232833 at the top-left to
> #12141a at the bottom-right, with a very faint grid of tiny barely-visible dots …
> INSIDE: one elegant thin warm amber curve #e0a458 sweeping … out through the upper right
> edge of the icon where it is CUT OFF by the icon boundary …

## 其它概念

`preview/concept-*.png` 是同批出的其它方向，留档备选：

| | 概念 | 表达 | 问题 |
|---|---|---|---|
| A | 星图 | 节点 + 连线 | 通用答案，跟别的关系图 App 撞脸 |
| B | 阶段框 | 琥珀虚线阶段框 | 框内节点偏小，左上略空 |
| C | 混合 | 虚线框 + 跨边界连线 | 偏挤 |
| D | 卡片 | 层叠节点卡 | 读起来像普通笔记 App |
| E | 切片 | 聚光节点 + 线跑出画面 | 那个大橙球太「App Store 通用发光图标」 |
| F | 阶段带 | 琥珀横带 + 穿带连线 | 粗得像进度条 |
| G | 经纬 | 琥珀纵轴 + 彩色横线 | 容易读成十字准星 / 表格 |
| **H** | **主线** | **琥珀主线穿出画框** | **← 采用** |

`icon.swift` 是另一条独立的路：用 CoreGraphics 直接矢量画，
好处是完全可控、不依赖任何模型输出，配色也直接来自 app 源码。
它同时是这份文档里「app 视觉 token」的活字典（配色常量与
`src/styles.css` 同步）。目前成品走的是 AI + 合成那条路。

## 已知限制

- `.icns` 里带 alpha 通道，**本机发行没问题**；上 Mac App Store 必须把 alpha
  压成白底（App Store 校验会拒）。
- 源图是 2048，master 是从它缩出来的 1024。

## 改了图标但 Dock 还是通用占位图？

大概率不是图标文件的问题。排查顺序：

1. **先渲染一遍**：`NSWorkspace.shared.icon(forFile: appPath)` 出得来我们的图
   → 说明 `.icns` 和 `Info.plist` 都没问题 → 往下走
2. **查 LaunchServices 注册表里有没有悬空条目**：

   ```bash
   LSR=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
   $LSR -dump | python3 -c "
   import sys,re
   txt=sys.stdin.read()
   for b in txt.split('-'*80):
   >   if 'com.lifecanvas.app' in b and 'bundle id:' in b:
   >     m=re.search(r'^\s*path:\s+(.+?)\s+\(0x', b, re.M)
   >     if m: print(m.group(1))"
   ```

   每条 path 都 `os.path.exists` 一下。指向已删除目录的那条就是悬空注册。
3. **清缓存 + 重新注册 + 重启 Dock**：

   ```bash
   $LSR -u <悬空路径>
   rm -f /private/var/folders/*/*/C/com.apple.iconservices/store.index
   $LSR -f macos/.build/LifeCanvas.app
   killall Dock; killall Finder
   ```

### 这个坑的根因（已修）

早期 `build.sh` 在临时目录里拼了一个**完整的 `.app`**：

```
$STAGE/LifeCanvas.app/Contents/...
```

LaunchServices 会把它当成一个真 app 注册进去；临时目录删掉后，这条注册就悬空了，
**还占着同一个 bundle id**。Dock / 启动台按 id 解析时就可能落到这条空壳上 → 通用占位图标。

现在暂存区是**无扩展名的普通目录**，只有最后才 `ditto` 成 `LifeCanvas.app`：

```
$STAGE/staging/Contents/...
```

LS 不认它，也就不会留下悬空注册。另外沙盒容器目录
（`~/Library/WebKit/com.lifecanvas.app`）也会被注册成同 id 的 bundle，同样是干扰源。
