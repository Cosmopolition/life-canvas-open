# go/no-go 冒烟测试结论

**结论：GO。** WKWebView + 自定义 scheme 直接装 `dist/`，life-canvas 的存储层、
加密层、Worker 三条依赖链全部可用，web 侧不需要为桌面端做任何改写。

跑 `./macos/SmokeTest/run.sh` 可复现（会自己 build web + swiftc 编译 + 跑两轮）。

## 判定项与实测

| 项 | 结果 | 说明 |
|---|---|---|
| `isSecureContext` | ✅ `true` | `app://local` 被 WebKit 视为 secure context。**这是最大的赌注，现在证伪了** |
| `indexedDB` | ✅ 开 + 读写成功 | Dexie `life-canvas` 库建成，`dbVersion: 40`（schema v4 的 Dexie 内部 ×10），9 张表齐全含 `milestones` |
| `crypto.subtle` | ✅ | PBKDF2(1000 轮, SHA-256) → `deriveKey` AES-GCM 256 成功 |
| `Worker`（file + module） | ✅ | 真实的 `indexer.worker-*.js` 收发正常，回 `{"t":"added","size":1}` |
| 跨启动持久化 | ✅ | phase1 写 marker → 退出 → phase2 原样读回 |
| 真应用 boot | ✅ | canvas 608×1096 已绘制，Dexie 正常初始化 |

## 两个实测踩到的坑（都写进 main.swift 注释了）

### 1. `mimeType` 不能带 `; charset=utf-8`

`URLResponse(url:mimeType:expectedContentLength:textEncodingName:)` 里如果写成
`"text/html; charset=utf-8"`，Foundation 原样存这串，WebKit 按**精确类型**查表 ——
带参数查不到，于是当纯文本渲染，页面的 HTML 源码被转义后塞进 `<pre>` 显示。

表现极具迷惑性：不报任何错，页面就是一片空白/源码，很难联想到 Content-Type。
字符集要通过单独的 `textEncodingName` 参数传。

### 2. `indexer.worker` 没有启动消息

worker 只在收到 `onmessage` 后才回。写探测时被动等 `onmessage` 必然超时 ——
我第一版探测就是这么写的，两种 worker 全部 timeout，差点误判成
"自定义 scheme 下 Worker 不可用"这个致命结论。要先发一条消息再等回复。

## 还没验的

- **App Store 政策面**：Guideline 4.2（"repackaged website"）是否认可、
  中国区上架需要的软著/ICP 备案。这些是人工审核，代码测不出来。
- **沙箱容器下的存储位置**：本次是裸二进制无 bundle id 跑的。上架版本有正式
  bundle id + sandbox，IndexedDB 会落到 app container 内，需要再验一次持久化。
- **原生能力**：Touch ID 呼出解锁、菜单栏、文件导入导出、备份目录选择器。