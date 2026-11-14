# LifeCanvas —— macOS 原生外壳

原生窗口壳 + WKWebView 装 `dist/`。业务逻辑一行都不在原生侧重复实现：
顶栏只负责发命令，所有动作交给 web 去做。

> **这一层的坑单独成文 → [`docs/macos-shell.md`](../../docs/macos-shell.md)**
>
> 那里有十五道「会静默失败」的坑（`URLResponse` 的 url、`mimeType` 必须裸 MIME、
> 沙盒里 `network.client` 必须为 true、`<a download>` 必须回 `.download`…），
> 以及 `app://` scheme 的实现要点、导入导出链路、签名三坑、换 bundle id 怎么迁数据。
> 改原生侧之前**先读那份** —— 这里的每个坑都不报错，只会"某处莫名其妙不工作"。

---

## 源码构成

```
macos/
  LifeCanvas/      ← 外壳本体（进版本库）
    AppDelegate.swift        应用入口、命令行参数（--selftest / --shot）
    MainWindowController.swift 窗口、工具栏、菜单
    SchemeHandler.swift      app:// 协议处理（把 dist/ 喂给 WKWebView）
    Bridge.swift             web ↔ 原生的消息通道
    L10n.swift               原生侧的文案表（键 = 英文 slug，与 web 侧共用命名空间）
    SelfTest.swift           80 条断言的自测
    WindowShot.swift         窗口离屏渲染成 PNG
    Info.plist               bundle id、版本号、权限声明
    LifeCanvas.entitlements  沙盒权限
  SmokeTest/       ← go/no-go 冒烟测试（可复现的验证资产）
  build.sh         ← npm run build → swiftc → 组装 .app → ad-hoc 签名
  release.sh       ← universal 二进制 + 正式签名（给「要给别人装」用）
```

---

## 用法

```bash
./macos/build.sh                  # 出 macos/.build/LifeCanvas.app
open macos/.build/LifeCanvas.app
```

免重打包热更（改完 web 只需 `npm run build`）：

```bash
# ⚠️ 必须用**未签名的**那个二进制 —— .app 带沙盒，读不到容器外的 dist
LIFECANVAS_DIST="$PWD/dist" macos/.build/LifeCanvas-dev
```

跑断言（80 条，不需要人眼）：

```bash
# ⚠️ 打包好的 .app 要**不设** LIFECANVAS_DIST（设了也读不到）
macos/.build/LifeCanvas.app/Contents/MacOS/LifeCanvas --selftest
```

`--selftest` 会自动跨过首启的加密门禁和新手引导，然后逐档测断点。
截图权限拿不到、只能靠断言的时候，它就是替代品。

> ⚠️ **自测跑在真实容器上** —— 它会临时改设置、动到自己的库，跑完自动还原。
> 别在别人的机器上乱跑。

---

## 看原生窗口长什么样

`--shot` 把窗口离屏渲染成 PNG（AppKit 自己画，不需要「屏幕录制」权限）：

```bash
macos/.build/LifeCanvas.app/Contents/MacOS/LifeCanvas \
  --shot "$PWD/shots/native" --shot-size 1280x840 \
  --shot-view canvas --shot-appearance dark
```

参数表与已知限制见 [`docs/macos-shell.md`](../../docs/macos-shell.md)。

---

## 两条铁律

1. **原生侧不重复实现业务逻辑。** 原生只管窗口级的事（标题栏、菜单栏、窗口外观），
   逻辑一律在 `src/`。原生要什么动作，就发一条命令给 web。
2. **版本号的真源是 `Info.plist`。** App Store 上架、Finder「关于本机」、
   `release.sh` 的自检读的都是它 —— 构建时从那里注入 web，运行时原生再把
   Bundle 里的版本报回来。`package.json` 里**没有**版本号，别加。

---

## 界面语言

菜单栏、工具栏、窗口标题都有中英两套，跟网页那一侧同步。

原生侧的文案表在 `L10n.swift`，键是**英文 slug**，跟 web 侧共用一个命名空间
（`view.today`、`action.settings` 这些两边是同一个键）。
共用键的中英文**必须逐字一致** —— `npm run i18n:native` 核的就是这件事。

**语言是谁说了算**：

```
用户显式偏好（设置面板里锁过）  >  原生报来的系统语言  >  浏览器语言
```

web 是权威：原生在 web 起来之前先按系统语言摆个不刺眼的默认值，
web 加载后报出最终语言，原生把菜单 / 工具栏 / 窗口标题整体重刷一遍。
