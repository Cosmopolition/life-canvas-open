# 贡献指南 · Contributing

先说四句要紧的：

1. **主线保持克制。** 这个项目开源是为了**让更多人用起来**，不是用来堆功能。
   我们会接「让别人更容易上手 / 更容易迁移进来 / 更容易自动化」的改动；
   「再加一个功能」类需求请先开 issue 讨论，别直接 PR。
2. **动数据格式之前先讨论。** 节点 / 关系 / 主题 / 阶段 / 版本历史这些结构，
   还有 JSON / Markdown / JSON Canvas 三种导出格式，是这个项目**对外的契约** ——
   改它们等于改别人的数据。请先开 issue。
3. **不要引入运行时依赖。** 现在 `dist/` 是零外部依赖、不发任何网络请求的纯静态产物；
   字体走系统栈，不引 CDN。这条是产品的卖点（也是隐私承诺的一部分），别破坏它。
4. **不要引入后台网络请求。** 现在全仓只有一处对外请求（复盘卡片拉用户自己贴的
   图片 URL）。加上别的，要先把「为什么」写进 PR 描述。

> English contributors: the four rules above are the whole policy. Everything else here is
> about *how*, not *what*. **Code comments and commit messages may be in Chinese or English** —
> both are welcome. UI strings live in `src/i18n/strings.ts` with the Chinese and the English
> side by side.

---

## 跑起来

```bash
npm install
npm run dev          # http://127.0.0.1:5178
```

桌面版（macOS 13+，需要 Xcode 命令行工具）：

```bash
./macos/build.sh                                  # → macos/.build/LifeCanvas.app
```

免打包热更（改完 `dist/` 直接跑，不用重编原生壳）：

```bash
npm run build
LIFECANVAS_DIST="$PWD/dist" ./macos/.build/LifeCanvas-dev
```

> ⚠️ 热更必须用**未签名**的那个二进制 —— 打包好的 `.app` 带沙盒，读不到容器外的
> `dist/`（原因见 [`docs/macos-shell.md`](docs/macos-shell.md)）。

---

## 提交前必须过的三道关

```bash
npm run typecheck        # tsc --noEmit，必须无错
npm test                 # vitest，全绿（366 条）
npm run i18n             # 文案表体检：英文表不能有漏翻、占位符要对得上
```

另外两条也建议跑（CI 会跑）：

```bash
npm run lint             # eslint（0 error；warning 可以有）
npm run i18n:native      # 核对原生壳与 web 侧共用的文案键逐字一致
```

改了原生侧（`macos/LifeCanvas/*.swift`）还要跑原生自测：

```bash
./macos/.build/LifeCanvas.app/Contents/MacOS/LifeCanvas --selftest
```

> ⚠️ 自测跑在**真实容器**上（你机器上那个 app 的沙盒目录），
> 它会临时改设置（界面语言、侧栏宽度），**跑完会自动还原**。
> 别在别人的机器上乱跑。

---

## 改界面文案（i18n）

文案表在 `src/i18n/strings.ts`，**一条就是一条，中英文并排**：

```ts
'action.deleteTheme': { zh: '删除主题', en: 'Delete theme' },
```

键是**英文 slug**，不是中文原文。这么做的理由（也是这个项目改过一次的设计）：

- **改中文措辞不会打断英文翻译**。旧设计里 `t('删除主题')` 改一个字就等于换键，
  英文会静默失效、界面上冒回中文，而且**不报任何错**。
- 键名本身是可读的标识符，一眼能看出作用。
- 加一句文案 = 加**一行**，翻译的人不用在两个文件之间跳。

所以加一条文案要做两件事：

1. 在 `src/i18n/strings.ts` 里加一行（**中英文都要写**，没想好英文就写个准确的草稿，
   后面再改 —— 但不能留空）；
2. 在代码里用 `t('你的.key')` 调用它。

**漏了英文会怎样**：`npm run i18n` 会报出来 —— 它是守门人，别绕过它。
它还会检查：占位符中英文对不对得上、英文值里夹没夹中文、有没有漏网的**中文当键**。

插值写法：`t('已删除：{from} → {to}', { from, to })`，两边用同一个 `{参数}`。

### ⚠️ 落库的值不翻译

`node.status` 里存的就是 `进行中` 这样的**中文字符串**，用户的库里已经躺着一堆了。
翻译它等于数据迁移，会把老库的筛选、配色、导出全部弄坏。

所以规矩是：**存进库的永远是原值，显示时才查表翻译。**
显示名的对照表在 `src/i18n/contracts.ts`。

---

## 数据格式

节点 / 关系 / 主题 / 阶段 / 版本历史，以及三种导出格式，是**对外的契约**。
字段级说明在 [`docs/DATA-FORMAT.md`](docs/DATA-FORMAT.md)。

要改的话：

1. **先开 issue** 讨论，说明为什么要改、怎么保证老库还能读；
2. 改 `src/model/types.ts` 里的类型定义；
3. 在 `src/persist/db.ts` 里升 schema 版本并写迁移函数；
4. 在 `docs/DATA-FORMAT.md` 里留下记录 —— **改了格式不写文档，PR 不会被接**。

---

## 几条约定

- **依赖方向是单向的**：`src/model/` 不 import 任何上层模块 —— 它可以被拿去当库使。
  别在 model 里 import views / app / persist。
- **数据是用户的。** 任何新增的持久化字段都要考虑**加密**路径
  （`src/persist/crypto.ts` 的 AES-GCM 逐条加密），别绕过加密直写明文。
- **原生侧不重复实现业务逻辑。** 原生只管窗口级的事（标题栏、菜单栏、窗口外观），
  逻辑一律在 `src/`。
- **提交信息用中文或英文都行**，一句话说清做了什么。例：
  `修好空间索引：拖动过的点命中框还是旧的` / `fix spatial index: dragged nodes kept a stale hit box`
- **注释解释「为什么」，不只是「是什么」。** 这个项目的注释密度是有意的 ——
  很多地方记着踩过的坑，那是最值钱的部分。

---

## 什么 PR 我们会接

- 修 bug（尤其是数据丢失、加密、导出的）
- 导入器 / 导出器（Notion、Obsidian、日记 App……）
- 模板、主题包、节点类型建议
- 平台适配（Linux / Windows 壳、其他语言的 InfoPlist.strings）
- 文档、翻译、可复现构建
- **把项目带到新地方**：Obsidian 插件、CLI、别的编辑器里能用

**不会接的**：把项目改成别的东西、加与「人生梳理」无关的功能、把零依赖静态产物
改成需要后端才能跑。

---

## 讨论与提问

开 issue 就行。中文英文都可以。

---

许可证：见 [`LICENSE`](LICENSE)（MIT）。你贡献的内容同样按 MIT 发布。
