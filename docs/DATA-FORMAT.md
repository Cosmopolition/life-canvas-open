# 数据格式契约（Data Format Contract）

> 适用范围：**用户库（IndexedDB）** 与 **导出文件（JSON / Markdown / JSON Canvas）**
> 权威来源：`src/model/types.ts`（实体定义）· `src/persist/db.ts`（存储 schema）· `src/persist/export.ts`（导出格式）
> 当前契约版本：导出格式 `EXPORT_VERSION = 1.1.0` · 导出 `meta.schema = 1` · 存储 schema `v4`

---

**English summary.** This document is the field-level contract for every byte the
app persists or exports. It defines eight entities (node, edge, theme, stage,
milestone, version, custom status, settings), the ten node types and nine edge
types with their directional validity constraints, the space-id rules, the
IndexedDB schema (database `life-canvas`, version 4) and its upgrade strategy,
the encryption boundary (AES-GCM-256 per record; `id` / `spaceId` / `updatedAt`
/ node `type` stay in plaintext), the three export formats (JSON bundle, Markdown,
JSON Canvas) with their exact round-trip fidelity, the overwrite-only JSON
import, and the rules for changing any of it without breaking existing libraries.

---

## 0. 这份文档的地位与读法

- **这是一份对外契约**：用户库里存的就是这些结构，导出文件也是这些结构。
  fork 之后改字段会把自己的旧库弄坏；社区写导入器 / 导出器要照这份文档来。
- **源码是唯一权威**。本文件的每一条都对着源码核对过。
  凡是与源码不符的旧文档（如早期内部技术文档里已被取代的 `Area` /
  `areaIds` / `Tag` / `Attachment` 形状），**以本文件为准**（见 [§15 已知偏差](#15-已知偏差与待确认)）。
- 表里三列的含义：
  - **进版本历史** —— 该字段变化会不会给节点产生一条 `Version`。
    只有 `title` / `content` / `status` / `time` / `tags` / `type` 会（见 [§8](#8-版本历史version)）。
  - **加密** —— 该字段在磁盘上是不是明文。
  - **必填** —— 导出文件里"应该出现"的字段。
    ⚠️ 必填 ≠ 一定有值：`store.addNode` 对可选字段是"传了才写"，不传就是**字段不存在**（不是 `null`）。

---

## 1. 实体总览

### 1.1 实体清单

| 实体 | TS 接口 | `kind` | 存放位置 | 说明 |
|---|---|---|---|---|
| 点 | `LifeNode` | `'node'` | `nodes` 表 | 一切内容的载体，10 种类型 |
| 关系 | `LifeEdge` | `'edge'` | `edges` 表 | 点与点 / 点与主题 / 主题与主题……带方向 |
| 主题 | `LifeTheme` | `'theme'` | `themes` 表 | 长期关注领域，**可嵌套** |
| 阶段 | `LifeStage` | `'stage'` | `stages` 表 | 时段，**平级**，带起止月份 |
| 里程碑 | `Milestone` | `'milestone'` | `milestones` 表 | 只挂在 `goal` 节点下的时间点位 |
| 版本 | `Version` | —（无 `kind`） | `versions` 表 | 节点的历史快照 |
| 自定义状态 | `CustomStatus` | —（无 `kind`） | `customStatuses` 表 | 用户自建的目标状态 |
| 设置 | `Settings` | — | `meta` 表 | 非实体，偏好与开关 |

`Library` 是内存里的全部数据，一次性装下前七项：

```ts
interface Library {
  nodes: LifeNode[];
  edges: LifeEdge[];
  themes: LifeTheme[];
  stages: LifeStage[];
  milestones: Milestone[];
  versions: Version[];
  customStatuses: CustomStatus[];
}
```

### 1.2 实体关系

```text
                              Library
      ┌────────────┬────────────┬────────────┬────────────┐
      │   nodes    │   edges    │   themes   │   stages   │
      └─────┬──────┴─────┬──────┴─────┬──────┴─────┬──────┘
            │            │            │            │
            │            │ fromId / toId            │
            │            │ fromKind / toKind        │
            │            ▼            ▼            ▼
            │        节点 ───────── 主题 ──────── 阶段
            │          │  ▲           ▲            ▲
            │          │  │           │            │
            │          │  └ themeIds ─┘            │
            │          └──── stageIds ──────────────┘
            │        （归属由 themeIds / stageIds 权威持有，
            │          画布上的"属于"边只是派生投影，不存储）
            ▼          ▼
      ┌───────────┐  ┌────────────┐
      │milestones │  │  versions  │   versions.nodeId      → 节点
      │parentId   │  └────────────┘   milestones.parentId  → goal 节点
      │→ goal 节点│
      └───────────┘

      customStatuses：独立表，不与任何实体连边
      settings / cryptoConfig：meta 表里的键值对
```

### 1.3 实体种类（`EntityKind`）

```ts
type EntityKind = 'node' | 'theme' | 'stage' | 'area';
```

- `'area'` 是**旧版 `LifeArea` 的残留**，**只允许出现在 `runSchemaMigration` 内部**。
  迁移完成后数据库里不应再有 `area` 实体；普通连线流程也造不出 `area` 引用
  （`EDGE_CONSTRAINTS` 不接受它）。
- 导入器 / 导出器**不应**产生 `'area'`。

### 1.4 ID 规则

```ts
const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
```

| 实体 | 前缀 | 形态 |
|---|---|---|
| 点 | `n-` | `n-m1a2b3c4d5e6` |
| 关系 | `e-` | `e-…` |
| 主题 | `t-` | `t-…` |
| 阶段 | `s-` | `s-…` |
| 里程碑 | `ml-` | `ml-…` |
| 版本 | `v-` | `v-…` |

- ID 只是**字符串**，导入时可以自带任意 ID；但**必须全局唯一**。
- ⚠️ `uid()` 由「毫秒时间戳 base36 + 6 位随机」拼成，**不保证绝对唯一**（同一毫秒内并发创建理论上可能撞）。
  导入器若要生成新 ID，建议自行加长随机段。

---

## 2. 公共字段（`Base`）

`LifeNode` / `LifeEdge` / `LifeTheme` / `LifeStage` / `Milestone` 都继承下面四个字段。
`Version` 与 `CustomStatus` **不继承** `Base`。

| 字段 | 类型 | 必填 | 含义 | 进版本历史 | 加密 |
|---|---|---|---|---|---|
| `id` | `string` | 是 | 实体 id（见 §1.4） | 否 | 是（payload 内）；行级另有明文列 `id` |
| `spaceId` | `string` | 是 | 所属空间（见 [§7](#7-空间space)） | 否 | 是（payload 内）；行级另有明文列 `spaceId` |
| `createdAt` | `number` | 是 | 创建时刻（Unix ms） | 否 | 是（payload 内） |
| `updatedAt` | `number` | 是 | 最后修改时刻（Unix ms） | 否 | 是（payload 内）；行级另有明文列 `updatedAt` |

---

## 3. 点（`LifeNode`）

### 3.1 十种点类型

| `type` | 显示名 | 稳定色 | 说明 |
|---|---|---|---|
| `goal` | 目标 | `#d99a4e` | 唯一会带 `status` 状态机的类型；里程碑只能挂在它下面 |
| `event` | 事件 | `#7f9bd4` | |
| `emotion` | 情绪 | `#b98ac9` | |
| `idea` | 想法 | `#c9a86a` | |
| `person` | 人物 | `#6fae8f` | |
| `resource` | 资源 | `#b0a58c` | |
| `action` | 行动 | `#8a9a86` | `done` 主要给它用 |
| `reflect` | 反思 | `#8f8fd4` | 带 `周复盘` 标签时 = 那一周的周复盘 |
| `place` | 地点 | `#c98a8a` | |
| `work` | 作品 | `#d47f9a` | |

- 显示名走 `t()`，随界面语言变；**稳定色不随语言变**（UI 与导出共用）。
- `type` 是**枚举**：`NODE_TYPES` 之外的字符串类型上编译不过。

### 3.2 字段表

| 字段 | 类型 | 必填 | 含义 | 进版本历史 | 加密 |
|---|---|---|---|---|---|
| `id` | `string` | 是 | 实体 id | 否 | 是；行级明文列 `id` |
| `kind` | `'node'` | 是 | 实体种类判别式，固定 `'node'` | 否 | 是 |
| `spaceId` | `string` | 是 | 所属空间 | 否 | 是；行级明文列 `spaceId` |
| `createdAt` | `number` | 是 | 创建时刻（ms） | 否 | 是 |
| `updatedAt` | `number` | 是 | 最后修改时刻（ms） | 否 | 是；行级明文列 `updatedAt` |
| `type` | `NodeType` | 是 | 十种点类型之一 | **是** | 是；**行级另有明文列 `type`**（不解密也能按类型筛） |
| `title` | `string` | 是 | 标题 | **是** | 是 |
| `content` | `string` | 是 | 正文（纯文本 / Markdown） | **是** | 是 |
| `status` | `string` | 否 | 目标状态（见 §3.3） | **是** | 是 |
| `done` | `boolean` | 否 | 是否完成。主要用于 `action`；`goal` 走自己的 `status` | **否**（轻量字段） | 是 |
| `time` | `string` | 否 | `'YYYY-MM'` 或 `'YYYY-MM-DD'` | **是** | 是 |
| `tags` | `string[]` | 是 | 标签数组（普通标签不翻译） | **是** | 是 |
| `themeIds` | `string[]` | 是 | 主题归属（**权威字段**） | **否** | 是 |
| `stageIds` | `string[]` | 是 | 阶段归属（**显式**部分；另有时基自动命中，见 §5.2） | **否** | 是 |
| `x` | `number` | 是 | 全局画布坐标 x（**不属于任何面**） | **否** | 是 |
| `y` | `number` | 是 | 全局画布坐标 y | **否** | 是 |
| `w` | `number` | 是 | 宽（px） | **否** | 是 |
| `h` | `number` | 是 | 高（px） | **否** | 是 |
| `imageData` | `string` | 否 | 封面图（base64 dataURL）。任意类型都可贴 | **否** | 是 |
| `imageW` | `number` | 否 | 收录后缩到 ≤800px 的自然像素宽 | **否** | 是 |
| `imageH` | `number` | 否 | 收录后缩到 ≤800px 的自然像素高 | **否** | 是 |
| `imageUrl` | `string` | 否 | 封面图外链 URL（优先级低于 `imageData`） | **否** | 是 |
| `linkUrl` | `string` | 否 | 关联文档链接（网页 / wiki / PDF / Notion…） | **否** | 是 |
| `linkLabel` | `string` | 否 | 链接显示文本；Markdown 导出时用它 | **否** | 是 |
| `sourceId` | `string` | 否 | 引入自哪个节点（周画布里从主画布复制的副本） | **否**（轻量字段） | 是 |

### 3.3 目标状态（`status`）

```ts
const GOAL_STATUS = ['无目标', '想法', '探索中', '进行中', '已完成', '搁置', '放弃', '已取代'] as const;
```

- **状态值本身是数据，不能翻译**。用户库里躺着一堆 `'进行中'` 这样的中文字符串，
  翻译它等于数据迁移，会把老库的筛选、配色、导出全弄坏。只有**显示**走 `t()`。
- 用户可以在内置集合之外**追加**自定义状态（`CustomStatus`），排在所有内置状态之后。
  自定义状态没有对照表，原样显示。
- `status` 语义上只对 `type === 'goal'` 有意义，但字段本身是可选的，任何类型都可以带。

### 3.4 标签

- 标签是**普通字符串数组**，用户自己的内容，**不翻译**。
- 两个**系统标签**例外：`周复盘`、`日记` —— 它们的**显示名**随界面语言变，**存进库的永远是原值**。
- `reflect` 类型的点 + `周复盘` 标签 ⇒ 这条是"那一周的周复盘"。

### 3.5 新建时的默认值（`store.addNode`）

| 字段 | 不传时的值 |
|---|---|
| `id` | `uid('n-')` |
| `kind` | `'node'` |
| `spaceId` | 当前空间（`store.currentSpaceId`） |
| `title` | `'未命名'` |
| `content` | `''` |
| `tags` / `themeIds` / `stageIds` | `[]` |
| `x` / `y` | `0` |
| `w` / `h` | `240` / `84` |
| `createdAt` / `updatedAt` | `Date.now()` |
| `status` / `time` / `done` / `image*` / `link*` / `sourceId` | **字段不存在** |

- 尺寸下限 `MIN_NODE_W = 120`、`MIN_NODE_H = 56`（缩放手柄夹在这里）。
- ⚠️ `addNode` 对可选字段是"**传了才写**"。周画布的"引入本周原数据"是**复制**，
  所以 `imageData` / `imageUrl` / `linkUrl` / `linkLabel` / `done` / `sourceId` 都被显式拷贝——
  类型允许但运行时不写，是最难查的一种坑。

---

## 4. 关系（`LifeEdge`）

### 4.1 九种关系类型

| `type` | 显示名 | 稳定色 | 可手工连 | 对称 |
|---|---|---|---|---|
| `belong` | 属于 | `#626a79` | **否** | — |
| `support` | 支持 | `#6fae8f` | 是 | 否 |
| `block` | 阻碍 | `#e06a6a` | 是 | 否 |
| `cause` | 导致 | `#c9a86a` | 是 | 否 |
| `replace` | 取代 | `#e0a458` | 是（**起点必须是 `goal`**） | 否 |
| `reference` | 参考 | `#7f9bd4` | 是 | 否 |
| `conflict` | 冲突 | `#d47f9a` | 是 | **是** |
| `inspire` | 启发 | `#b98ac9` | 是 | 否 |
| `sequence` | 时间顺序 | `#8b93a1` | 是 | **是** |

#### `belong` 的特殊性（重要）

- `belong` **不出现在 `EDGE_CONSTRAINTS` 里**，`canConnect('belong', …)` 直接返回 `false`。
- 归属的**权威字段是 `node.themeIds` / `node.stageIds`**；
  画布上看到的"属于"边是**自动派生的投影**（渲染层按 `themeIds` / `stageIds` 现场画虚线），
  **不存储、不落库、不参与手工连线**。
- 所以：**库里永远不应该有 `type === 'belong'` 的边**。导入器不要造它。

### 4.2 方向与合法目标约束

关系**带方向**：`fromId → toId`。约束表定义「某类型的关系，起点可以是哪些实体、终点可以是哪些实体」：

| 关系类型 | 起点实体种类 | 起点点类型限制 | 终点实体种类 | 对称 |
|---|---|---|---|---|
| `support` | `node` | — | `node` | 否 |
| `block` | `node` | — | `node` | 否 |
| `cause` | `node` | — | `node` | 否 |
| `replace` | `node` | **必须是 `goal`** | `node` | 否 |
| `reference` | `node` / `theme` / `stage` | — | `node` / `theme` / `stage` | 否 |
| `conflict` | `node` / `theme` / `stage` | — | `node` / `theme` / `stage` | **是** |
| `inspire` | `node` | — | `node` | 否 |
| `sequence` | `node` | — | `node` | **是** |

等价的源码形状：

```ts
export const EDGE_CONSTRAINTS: Record<Exclude<EdgeType, 'belong'>, EdgeConstraint> = {
  support:   { from: ['node'], to: ['node'], symmetric: false },
  block:     { from: ['node'], to: ['node'], symmetric: false },
  cause:     { from: ['node'], to: ['node'], symmetric: false },
  replace:   { from: ['node'], to: ['node'], fromNodeTypes: ['goal'], symmetric: false },
  reference: { from: ['node', 'theme', 'stage'], to: ['node', 'theme', 'stage'], symmetric: false },
  conflict:  { from: ['node', 'theme', 'stage'], to: ['node', 'theme', 'stage'], symmetric: true },
  inspire:   { from: ['node'], to: ['node'], symmetric: false },
  sequence:  { from: ['node'], to: ['node'], symmetric: true },
};
```

判定规则（`canConnect`）：

1. `belong` ⇒ 恒 `false`。
2. 起点实体种类 ∉ `from` ⇒ `false`。
3. 终点实体种类 ∉ `to` ⇒ `false`。
4. 约束带 `fromNodeTypes` 且起点有 `type` 且 `type` ∉ `fromNodeTypes` ⇒ `false`。

额外规则：

- **跨空间连线不允许**：一条边的两端必须属于同一个空间。
  `store.addEdge` 会抛错兜底（脏数据、脚本调用都绕不过去）。
- 主题 / 阶段没有独立空间语义 ⇒ 边的 `spaceId` 取**点那一端**的空间。

### 4.3 字段表

| 字段 | 类型 | 必填 | 含义 | 进版本历史 | 加密 |
|---|---|---|---|---|---|
| `id` | `string` | 是 | 关系 id（`e-` 前缀） | 不适用（边无版本历史） | 是；行级明文列 `id` |
| `kind` | `'edge'` | 是 | 固定 `'edge'` | 不适用 | 是 |
| `spaceId` | `string` | 是 | 两端共同的空间 | 不适用 | 是；行级明文列 `spaceId` |
| `createdAt` | `number` | 是 | 创建时刻（ms） | 不适用 | 是 |
| `updatedAt` | `number` | 是 | 最后修改时刻（ms） | 不适用 | 是；行级明文列 `updatedAt` |
| `fromId` | `string` | 是 | 起点实体 id | 不适用 | 是 |
| `fromKind` | `EntityKind` | 是 | 起点实体种类 | 不适用 | 是 |
| `toId` | `string` | 是 | 终点实体 id | 不适用 | 是 |
| `toKind` | `EntityKind` | 是 | 终点实体种类 | 不适用 | 是 |
| `type` | `EdgeType` | 是 | 九种关系类型之一 | 不适用 | 是 |
| `note` | `string` | 否 | 关系备注 | 不适用 | 是 |

⚠️ `fromId` / `toId` **不建索引**：加密开启时它们属于结构信息，不应明文可查。

---

## 5. 主题（`LifeTheme`）与阶段（`LifeStage`）

### 5.1 主题：可嵌套

| 字段 | 类型 | 必填 | 含义 | 进版本历史 | 加密 |
|---|---|---|---|---|---|
| `id` | `string` | 是 | 主题 id（`t-` 前缀） | 否 | 是；行级明文列 `id` |
| `kind` | `'theme'` | 是 | 固定 `'theme'` | 否 | 是 |
| `spaceId` | `string` | 是 | 空间（新建时默认 `'default'`） | 否 | 是；行级明文列 `spaceId` |
| `createdAt` | `number` | 是 | 创建时刻（ms） | 否 | 是 |
| `updatedAt` | `number` | 是 | 最后修改时刻（ms） | 否 | 是；行级明文列 `updatedAt` |
| `name` | `string` | 是 | 主题名，**同级之间不必唯一** | 否 | 是 |
| `parentId` | `string \| null` | 是 | 父主题 id；`null` = 顶级 | 否 | 是 |
| `color` | `string` | 是 | 主题色（新建默认 `'#7f9bd4'`） | 否 | 是 |
| `description` | `string` | 否 | 描述 | 否 | 是 |

- **可嵌套**：事业 > 工程。链条由 `parentId` 表达。
- 删主题时，引用它的点的 `themeIds` 会被清掉，相关边也会被删。

### 5.2 阶段：平级 + 起止月份

| 字段 | 类型 | 必填 | 含义 | 进版本历史 | 加密 |
|---|---|---|---|---|---|
| `id` | `string` | 是 | 阶段 id（`s-` 前缀） | 否 | 是；行级明文列 `id` |
| `kind` | `'stage'` | 是 | 固定 `'stage'` | 否 | 是 |
| `spaceId` | `string` | 是 | 空间（新建时默认 `'default'`） | 否 | 是；行级明文列 `spaceId` |
| `createdAt` | `number` | 是 | 创建时刻（ms） | 否 | 是 |
| `updatedAt` | `number` | 是 | 最后修改时刻（ms） | 否 | 是；行级明文列 `updatedAt` |
| `name` | `string` | 是 | 阶段名 | 否 | 是 |
| `color` | `string` | 是 | 阶段色（新建默认 `'#7f9bd4'`） | 否 | 是 |
| `start` | `string` | 否 | 起始月 `'YYYY-MM'` | 否 | 是 |
| `end` | `string` | 否 | 结束月 `'YYYY-MM'` | 否 | 是 |
| `description` | `string` | 否 | 描述 | 否 | 是 |

阶段约定：

- **平级**：`LifeStage` **没有 `parentId`**，阶段之间不嵌套。
- `start` / `end` **可以只设一边**。
- `start > end` 视为**无效**（防御性：**不抛错、不自动交换**）⇒ 该阶段不产生任何时基成员。
- 节点归属某阶段的条件（**任一即可**）：
  1. `node.stageIds` 显式包含该阶段；
  2. `node.time` 归一化到月（取 `'YYYY-MM'` 前缀，`'2026-11-14'` → `'2026-11'`）后，
     落在 `[start?, end?]` 的**闭区间**内（只有一端时按那一端比）。
- 删阶段时，引用它的点的 `stageIds` 会被清掉，相关边也会被删。

### 5.3 里程碑（`Milestone`）

| 字段 | 类型 | 必填 | 含义 | 进版本历史 | 加密 |
|---|---|---|---|---|---|
| `id` | `string` | 是 | 里程碑 id（`ml-` 前缀） | **否** | 是；行级明文列 `id` |
| `kind` | `'milestone'` | 是 | 固定 `'milestone'` | **否** | 是 |
| `spaceId` | `string` | 是 | **等于父节点的空间** | **否** | 是；行级明文列 `spaceId` |
| `createdAt` | `number` | 是 | 创建时刻（ms） | **否** | 是 |
| `updatedAt` | `number` | 是 | 最后修改时刻（ms） | **否** | 是；行级明文列 `updatedAt` |
| `parentId` | `string` | 是 | 父节点 id，**必须是 `type === 'goal'` 的节点** | **否** | 是 |
| `title` | `string` | 是 | 标题（新建默认 `'未命名'`，会 trim） | **否** | 是 |
| `targetDate` | `string` | 是 | 计划完成日 `'YYYY-MM-DD'`（默认今天） | **否** | 是 |
| `completedAt` | `string` | 否 | 实际完成日 `'YYYY-MM-DD'`；未设置 = 待办 | **否** | 是 |
| `order` | `number` | 是 | 同级展示顺序；新建 = 同级最大 `order` + 1 | **否** | 是 |

- 派生状态（`pending` / `overdue` / `completed` / `completed-early` / `completed-late`）
  **现算不入库**。
- 删 `goal` 节点时，其名下所有里程碑一并清掉（不留僵尸数据）。

---

## 6. 自定义状态（`CustomStatus`）

| 字段 | 类型 | 必填 | 含义 | 进版本历史 | 加密 |
|---|---|---|---|---|---|
| `id` | `string` | 是 | 状态 id | 否 | **否**（整表明文 JSON，见 §11） |
| `name` | `string` | 是 | 状态名（原样显示，不翻译） | 否 | **否** |
| `order` | `number` | 是 | 排序，**排在所有内置状态之后** | 否 | **否** |

- `customStatuses` 表存的是**裸对象**（不是 `Row` 形状），**不加密**。
- 内置状态清单见 §3.3。

---

## 7. 空间（Space）

### 7.1 空间身份 = spaceId

**没有 spaces 表。** 空间的标题、起止、周次全部从 `spaceId` 字符串本身解析出来
——**空间身份就是它的 id**。库、加密、版本历史、搜索索引全部复用，它们本来就不区分空间。

```ts
const MAIN_SPACE = 'default';
const WEEK_PREFIX = 'week:';
```

| 空间 | `spaceId` 形态 | 例子 |
|---|---|---|
| 主空间 | `'default'` | `default` |
| 周空间 | `'week:'` + **周一日期** `'YYYY-MM-DD'` | `week:2026-11-02` |

### 7.2 周空间的 id 规则

- 周空间的 id 后缀**必须是那一周的周一**。`week:2026-11-03`（周二）是**坏 id**，
  `parseWeekSpace` 返回 `null` —— 与其猜它是哪一周的，不如当作不存在。
- 从任意日期算周一：`weekStart(date)`（本地时区，周一 = 0 … 周日 = 6）。
- 周日 = 周一 + 6 天。
- ISO 周号：`2026-11-02` → 第 45 周；`2026-12-28` → 第 53 周；`2027-01-04` → 第 1 周。
- 显示区间：同年 `'11/02–11/08'`；跨年 `'2026/12/28–2027/01/03'`。

### 7.3 空间约定

- `spaceId` 出现在**所有实体**上（`Base`），包括主题 / 阶段。
- **跨空间的边不允许存在**。边过滤用"两端都在空间内"。
- 节点的 `tags` 含 `'周复盘'` 且 `type === 'reflect'` ⇒ 这一周的周复盘。
- 日历 / 周历统计**只算主空间**：周画布里自己写的东西是产出，不是记录。
- 周空间里的节点可以是主空间节点的**副本**（`sourceId` 指向原件）。
  副本与原件从此分叉 —— 后来主画布上改了，周画布里的那份不受影响。

---

## 8. 版本历史（`Version`）

### 8.1 字段表

| 字段 | 类型 | 必填 | 含义 | 加密 |
|---|---|---|---|---|
| `id` | `string` | 是 | 版本 id（`v-` 前缀） | 是（payload 内） |
| `nodeId` | `string` | 是 | 属于哪个节点 | 是 |
| `snapshot` | `string` | 是 | **节点全字段快照的 JSON 字符串**（不含坐标） | 是 |
| `title` | `string` | 否 | **非空 = 手动标记的里程碑** | 是 |
| `reason` | `string` | 是 | 变更原因（**必填**） | 是 |
| `changedAt` | `number` | 是 | 变更时刻（Unix ms） | 是 |
| `changedFields` | `string[]` | 是 | 相对**上一条版本**发生变化的字段名 | 是 |

⚠️ `Version` **不继承 `Base`**：它没有 `spaceId` / `createdAt` / `updatedAt`，
用的是 `changedAt`。这一点在落库时有实际后果（见 §10.4）。

### 8.2 快照字段集合（唯一的权威清单）

```ts
const SNAPSHOT_FIELDS = ['title', 'content', 'status', 'time', 'tags', 'type'] as const;
```

快照的 JSON 形状（`null` 表示"当时没有这个值"，与"字段不存在"等价）：

```json
{
  "title": "标题",
  "content": "正文",
  "status": "进行中",
  "time": "2026-11-14",
  "tags": ["工作"],
  "type": "goal"
}
```

### 8.3 哪些字段**不**进版本历史

不在 `SNAPSHOT_FIELDS` 里 ⇒ 改它**不产生版本**：

`x` `y` `w` `h`（位置与尺寸）· `done` · `sourceId` · `themeIds` · `stageIds` ·
`imageData` `imageW` `imageH` `imageUrl` · `linkUrl` `linkLabel` ·
`spaceId` `createdAt` `updatedAt` · `id` · `kind`

源码注释里把这些叫**"轻量字段"**：状态与来源是"结构信息"，不是"内容修改"。

> ⚠️ 特别提醒：**改主题 / 阶段归属不产生版本**。归属是结构信息，
> 需要追溯"这个点什么时候换的主题"要靠别的手段（导出的 Markdown 里也不含）。

### 8.4 版本产生的时机

| 场景 | 行为 |
|---|---|
| `updateNode` 改了快照字段 | 600ms 防抖后合成**一条**版本 |
| `updateNode` 只改了轻量字段 | **不产生**版本 |
| 内容与最新版本快照完全一致 | **丢弃**（除非这次是打里程碑） |
| `flushVersion` | 强制立刻落一条版本（例如离开编辑框时） |
| `markMilestone` | 不改内容，单独记一条版本，`changedFields: []` |
| `restoreVersion` | 恢复本身**也产生一条新版本**，历史不丢 |

- `reason` 缺失时落库为 `'（未填写原因）'`（显示层翻译）。
- `title` 非空 = 这条被手动标成了**里程碑**。

---

## 9. 设置与元数据（`meta` 表）

`meta` 表是 `{ key: string; value: unknown }`，**明文存储**。

### 9.1 已知键

| key | value 形状 | 含义 |
|---|---|---|
| `'settings'` | `Settings` | 用户设置（见 §9.2） |
| `'settingsSchemaV2'` | `boolean` | 主题迁移标记（只迁一次） |
| `'cryptoConfig'` | `CryptoConfig` | 加密配置（见 §9.3） |
| `'cryptoEnabled'` | `boolean` | 加密开关的镜像标记 |
| `'pendingSchemaMigration'` | `number` | 待执行的数据迁移版本号（见 §10.3） |

### 9.2 `Settings`

| 字段 | 类型 | 必填 | 默认值 | 含义 |
|---|---|---|---|---|
| `searchContext` | `boolean` | 是 | `true` | 搜索命中后是否带出一跳邻居 |
| `lockMinutes` | `number` | 是 | `15` | 自动锁定分钟数 |
| `timelineLanes` | `string[]` | 是 | `[]` | 时间轴泳道（面）顺序 |
| `contrast` | `'normal' \| 'high'` | 是 | `'normal'` | 高对比度 |
| `scale` | `'md' \| 'lg' \| 'xl'` | 是 | `'md'` | 字体缩放 |
| `theme` | `'auto' \| 'dark' \| 'light'` | 是 | `'auto'` | 主题偏好（**偏好 ≠ 实际**，实际是 `auto` 解析后的结果） |
| `leftW` | `number` | 否 | `undefined` | 左栏宽（px）。`0` = 收起；`undefined` = 用断点默认值 |
| `rightW` | `number` | 否 | `undefined` | 右栏宽（px）。同上 |

读取时用 `defaultSettings()` 与库里的值做浅合并 ⇒ **缺字段是安全的**。

### 9.3 `CryptoConfig`

| 字段 | 类型 | 必填 | 默认值 | 含义 |
|---|---|---|---|---|
| `enabled` | `boolean` | 是 | `false` | 是否加密 |
| `salt` | `Uint8Array \| null` | 是 | `null` | PBKDF2 盐，16 字节 |
| `iterations` | `number` | 是 | `600000` | PBKDF2 迭代次数 |
| `verifier` | `Uint8Array \| null` | 是 | `null` | 已知 token 的密文，用于校验密码正确性 |

- `salt` 与 `verifier` 本身是**公开信息**（salt 公开；verifier 是已知 token 的密文，
  用来"验密码对不对"而不是"解密数据"）。真正的密钥永不落盘。
- `VERIFY_TOKEN = 'life-canvas/v1'`。

---

## 10. 持久化（IndexedDB）

### 10.1 库与表

- 库名：**`life-canvas`**（`new Dexie('life-canvas')`）。
- 引擎：Dexie 4.x。
- **当前 schema 版本：`v4`**。

| 表 | 存什么 | 形状 |
|---|---|---|
| `nodes` | `LifeNode` | `Row`（加密） |
| `edges` | `LifeEdge` | `Row`（加密） |
| `themes` | `LifeTheme` | `Row`（加密） |
| `stages` | `LifeStage` | `Row`（加密） |
| `milestones` | `Milestone` | `Row`（加密） |
| `versions` | `Version` | `Row`（加密） |
| `customStatuses` | `CustomStatus` | **裸对象，明文** |
| `meta` | 键值对 | **裸对象，明文** |

### 10.2 行结构（`Row`）

```ts
interface Row {
  id: string;
  spaceId: string;
  updatedAt: number;
  type?: string;      // 仅点记录有；用于不解密也能按类型筛选
  payload: Uint8Array; // 整个实体的 JSON（加密后）
}
```

**加密关闭与开启共用同一张表**：明文列只有 `id` / `spaceId` / `updatedAt` / `type`，
其余一律在 `payload` 里。这样两种模式只有一条读写代码路径。

### 10.3 索引（v4 完整声明）

| 表 | 主键 | 索引 |
|---|---|---|
| `nodes` | `id` | `spaceId`, `type`, `updatedAt`, `[spaceId+updatedAt]` |
| `edges` | `id` | `spaceId`, `updatedAt` |
| `themes` | `id` | `spaceId`, `parentId`, `updatedAt` |
| `stages` | `id` | `spaceId`, `updatedAt`, `start`, `end` |
| `milestones` | `id` | `spaceId`, `parentId`, `updatedAt` |
| `versions` | `id` | `spaceId`, `updatedAt`, `[spaceId+updatedAt]` |
| `customStatuses` | `id` | `name` |
| `meta` | `key` | — |

> ⚠️ **索引与行形状不一致的地方**（源码如此，不是笔误）：
> `Row` 里只有 `id` / `spaceId` / `updatedAt` / `type` 四个标量列，其余全在 `payload` 里。
> 因此：
> - `themes.parentId`、`milestones.parentId`、`stages.start`、`stages.end`
>   这几个索引**指向的字段根本不在行上 ⇒ 索引恒为空**。
> - `edges` 刻意不给 `fromId` / `toId` 建索引（加密开启时它们属于结构信息，不应明文可查）。
> - `nodes.type` 是唯一"行级真实存在"的业务索引（不解密即可按类型筛选）。
> - `Version` 没有 `spaceId` / `updatedAt` ⇒ **`versions` 表里这两列是 `undefined`**，
>   对应的索引也恒为空；版本实际只能按 `id` 找到。

### 10.4 schema 版本历史与升级策略

| 版本 | 变化 | 升级回调 |
|---|---|---|
| `v1` | 原始 schema（`nodes` / `edges` / `areas` / `versions` / `customStatuses` / `meta`） | — |
| `v2` | **新增** `themes` / `stages` 表；`areas` 暂留 | 有：写 `meta.pendingSchemaMigration = 2` |
| `v3` | **删除** `areas` 表 | 无 |
| `v4` | **新增** `milestones` 表 | 无（旧库的该表初始为空） |

**升级策略的三条规矩**（源自 v2 → v3 的既有做法）：

1. **纯新增表** → 直接加版本号，无需 `upgrade` 回调。
2. **要改数据** → **不能在 Dexie 的 `upgrade` 回调里做**：
   升级时拿不到主密码，加密数据解不开。
   正确做法是在 `upgrade` 里只写一个 `meta` 标记（`pendingSchemaMigration`），
   由**应用层**在拿到 key 之后再跑迁移函数（`Repository.runSchemaMigration()`）。
3. **迁移必须幂等**：失败时**保留标记**，下次启动重试；成功后清标记。

`runSchemaMigration()` 的实际动作（v2 → v3 遗留数据的清理，**跑在新库上是空操作**）：

1. 读 + 解密旧 `areas` 表；
2. 按 `type` 分类：`root`/`theme` → 主题；`stage`/`transition`/`year`/`project` → 阶段；其余（含 `role`）→ 丢弃；
3. 跨类型 `parentId` 置 `null`；从名字解析 `start` / `end`（如 `"2023-2025 星河"` → `2023-01` … `2025-12`）；
4. 写 `themes` / `stages`；
5. 遍历点行：`areaIds` 拆成 `themeIds` / `stageIds`；
6. 遍历边行：`fromKind`/`toKind === 'area'` 改写成 `theme` / `stage` / `node`；
7. `settings.timelineLanes` 过滤为只剩映射到主题的 id；
8. 清 `areas` 表、删标记。

### 10.5 写路径

- 内存 `Store` 维护**脏集合**（`'node:<id>'` / `'edge'` / `'versions'` / …）。
- `Repository` 订阅 store，**debounce 300ms** 后增量落盘：
  - 单条变更 ⇒ 只 `bulkPut` / `bulkDelete` 受影响的行；
  - `'nodes'` / `'edges'` / `'versions'` 这三个**全量标记** ⇒ 对应表 `clear()` 后整表重写；
  - `'status'` ⇒ `customStatuses` 整表 `bulkPut`。
- 加密并行：按 **500 条一批** `Promise.all`，避免串行 await 堵死主线程。
- `replaceAll(lib)`：**整库替换**（导入 / 改密码重写用）——先清空 6 张表 + `customStatuses`，再整表写回。

---

## 11. 加密边界

### 11.1 密码学参数

| 项 | 值 |
|---|---|
| 算法 | AES-GCM-256 |
| 密钥派生 | PBKDF2-HMAC-SHA256，**600,000** 次迭代 |
| 盐 | 16 字节随机 |
| IV | 12 字节随机，**每次加密重新生成** |
| 密钥可导出性 | **不可导出**（`extractable = false`） |
| 密文布局 | `IV(12B) ‖ ciphertext ‖ GCM tag` |

- `key === null`（加密关闭）⇒ **原样存 UTF-8 明文字节**，不做任何隐式加密。
- 密文格式 = `encryptBytes` 的输出（前 12 字节 IV，其余密文）。

### 11.2 哪些是明文

| 位置 | 明文内容 |
|---|---|
| `nodes` / `edges` / `themes` / `stages` / `milestones` / `versions` 的**行级列** | `id`、`spaceId`、`updatedAt`（+ 点的 `type`） |
| 上述表的 `payload` | **加密**（实体完整 JSON） |
| `customStatuses` 表 | **整表明文**（裸对象） |
| `meta` 表 | **整表明文**（含 `settings`、`cryptoConfig` 的 salt / verifier） |
| 搜索索引 | **不落库**（Worker 内存态，派生数据） |

源码里把这条泄漏明确写下来了：`id` / `spaceId` / `updatedAt` / 点类型 —— **UI 必须告知用户**。

### 11.3 开关密码时发生什么

- 开启：设密码 → 存 `cryptoConfig` → `repo.replaceAll(store.lib)` **用新密钥重写全部数据**。
- 关闭：`repo.setKey(null)` → 同样 `replaceAll` **用明文重写全部数据**。
- 两种状态**共用同一张表**，读路径完全一致。

---

## 12. 导出格式

三种格式的定位：**JSON 是完整保真的主格式；Markdown 是"给人看"的一层；JSON Canvas 是迁移出口。**

### 12.1 JSON bundle（主格式 · 可往返）

**文件名**：`life-canvas-YYYY-MM-DD.json`（`JSON.stringify(bundle, null, 2)`）

**顶层结构**：

```json
{
  "meta": {
    "app": "人生画布",
    "schema": 1,
    "version": "1.1.0",
    "exportedAt": "2026-11-14T09:48:00.000Z",
    "counts": {
      "nodes": 12,
      "edges": 7,
      "themes": 3,
      "stages": 2,
      "milestones": 1,
      "versions": 5
    }
  },
  "library": {
    "nodes": [],
    "edges": [],
    "themes": [],
    "stages": [],
    "milestones": [],
    "versions": [],
    "customStatuses": []
  }
}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `meta.app` | `'人生画布'` | **固定字面量**（应用标识符，不随界面语言变） |
| `meta.schema` | `number` | 导出结构版本，**目前恒为 `1`** |
| `meta.version` | `string` | 导出格式版本 = `EXPORT_VERSION` = `'1.1.0'`（与 `package.json` 的应用版本**无关**，是独立常量） |
| `meta.exportedAt` | `string` | 导出时刻（ISO 8601，UTC） |
| `meta.counts` | `object` | 六个集合的条数。⚠️ **不含 `customStatuses`** |
| `library` | `Library` | **整个库，原样序列化**（七个数组） |

`library` 里每个实体的形状**就是本文档 §3–§8 的字段表**，一一对应，不做任何转换。

### 12.2 Markdown（给人看 · 单向）

**文件名**：`life-canvas-YYYY-MM-DD.md`（`text/markdown`）

**排版约定**：

| 层级 | 内容 |
|---|---|
| `#` | 文档标题 `人生画布导出` |
| `>` | 副标题：导出时间 · `N 个点 / M 条关系` |
| `##` | **主题区段**（顶级主题）/ **阶段区段** |
| `###` | 子主题 / 区段内的点 |
| `####` | 点下的 `关系` 段 / `演变` 段 |

**点的写法**：

```markdown
### 目标：把项目做完 · **进行中** `2026-11-14` #工作 #重要

![](data:image/png;base64,....)
🔗 [需求文档](https://example.com/spec)

正文 Markdown 原样输出。

#### 关系

- → 支持 另一个点 —— 备注
- ← 阻碍 某个主题
- → **取代** 旧目标

#### 演变

- ★ `2026-11-14` 重新定义了目标（里程碑名）
- `2026-11-02` 第一次立项
```

规则：

- **标题**：`类型：标题`。`done` 为真时标题用 `~~标题~~`（删除线）。
- **状态**：`**状态**`，走显示名翻译。
- **时间**：`` `2026-11-14` ``（反引号包裹的原值）。
- **标签**：`#标签`，普通标签原样、系统标签走显示名。
- **封面图**：`imageData` 优先（内嵌 dataURL，自包含），否则 `imageUrl`。
- **链接**：`🔗 [linkLabel 或 linkUrl](linkUrl)`。
- **关系**：方向 `→` 表示该点是 `fromId`，`←` 表示该点是 `toId`；
  `replace` 类型的**关系名加粗**；备注以 ` —— ` 追加。
  被引用的一端已被删除时写 `(已删除)`。
- **演变**：**只有版本数 > 1 时才输出**；每条是 `★ 日期 原因（里程碑名）`，
  `★` 表示这条被手动标记为里程碑。**不含完整快照**。
- **排序**：区段内的点按 `time` **倒序**（无 `time` 的排在后面）。
- **主题区段**只收**直接**归属该主题的点（不含子主题的点），子主题递归另起一节。
- **阶段区段**收 `inStage` 命中的点（显式 `stageIds` ∪ 时基命中）。
- `focusId` 可限定只导出某个主题（含子主题）或某个阶段；id 找不到时**回退为全量**。

#### ⚠️ 导出文案的语言依赖（重要）

**Markdown 与 JSON Canvas 的文案随界面语言变，但 `library` 里的数据不变。**
`t()` 在英文界面查不到词条时**回退成中文原文**（并记进漏翻清单），于是两种语言的输出不一样：

| 片段 | 中文界面 | 英文界面 |
|---|---|---|
| 文档标题 | `人生画布导出` | `Life Canvas Export` |
| 副标题 | `12 个点 / 7 条关系` | `12 nodes / 7 relations` |
| 点的类型名 | `目标` | `Goal` |
| 点的状态名 | `进行中` | `In progress` |
| 关系段标题 | `关系` | `Relations` |
| 演变段标题 | `演变` | `History` |
| 已删除的一端 | `(已删除)` | `(deleted)` |

点的标题行用的是模板 `'{type}：{title}'` —— 中英文**都有词条**（英文是 `'{type}: {title}'`），
所以英文界面下整行是 `Goal: 把项目做完`，**连冒号形式都跟着语言走**。
JSON Canvas 的点正文用同一个模板（见 §12.3）。

⇒ **写导入器时不要把 Markdown / JSON Canvas 里的状态显示值当成库里存的原值**
（库里永远是 `'进行中'` 这样的中文原值，只有 JSON bundle 里是原值）。

⚠️ **两个必须知道的丢失**：

1. **不属于任何主题、也不属于任何阶段的点，不会出现在 Markdown 里。**
2. 同时属于主题和阶段的点，**会出现两次**（两个区段各一份）。

### 12.3 JSON Canvas（迁移出口 · 单向）

**文件名**：`life-canvas-canvas-YYYY-MM-DD.json`

对标 [JSON Canvas 1.0 规范](https://jsoncanvas.org/spec/1.0/)（根就是 `nodes` + `edges` 两个数组）。

```json
{
  "nodes": [
    {
      "id": "t-m1a2b3",
      "type": "group",
      "text": "# 事业",
      "x": 0, "y": 0, "width": 260, "height": 80,
      "color": "6"
    },
    {
      "id": "s-m1a2b4",
      "type": "group",
      "text": "# 2026 过渡期",
      "x": 0, "y": 0, "width": 260, "height": 80,
      "color": "5"
    },
    {
      "id": "n-m1a2b5",
      "type": "text",
      "text": "目标：把项目做完\n状态：进行中\n时间：2026-11-14\n\n正文 Markdown",
      "x": 120, "y": 40, "width": 240, "height": 84,
      "color": "1"
    }
  ],
  "edges": [
    {
      "id": "e-m1a2b6",
      "fromNode": "n-m1a2b5",
      "fromSide": "right",
      "toNode": "n-m1a2b7",
      "toSide": "left",
      "label": "支持 · 备注"
    }
  ]
}
```

**字段映射表**：

| 本项目 | JSON Canvas | 映射规则 |
|---|---|---|
| `LifeNode.id` | `nodes[].id` | 原样 |
| — | `nodes[].type` | 恒 `'text'` |
| `LifeNode.title` 等 | `nodes[].text` | 见下方「正文结构」 |
| `LifeNode.x` / `y` / `w` / `h` | `nodes[].x` / `y` / `width` / `height` | 原样 |
| — | `nodes[].color` | 恒 `'1'` |
| `LifeTheme.id` / `LifeStage.id` | `nodes[].id` | 原样（`type: 'group'`） |
| `LifeTheme.name` / `LifeStage.name` | `nodes[].text` | `'# ' + name` |
| — | 主题 group 的 `x/y/width/height` | 固定 `0 / 0 / 260 / 80` |
| — | 主题 group 的 `color` | `theme.color === '#e0a458' ? '1' : '6'` |
| — | 阶段 group 的 `color` | 恒 `'5'` |
| `LifeEdge.id` | `edges[].id` | 原样 |
| `LifeEdge.fromId` / `toId` | `edges[].fromNode` / `toNode` | 原样 |
| — | `edges[].fromSide` / `toSide` | 固定 `'right'` / `'left'` |
| `LifeEdge.type` (+ `note`) | `edges[].label` | 关系显示名（+ `' · ' + note`） |

**点的正文结构（行结构是数据契约，但字段名的翻译状态是"半吊子"，见下）**：

```text
类型：标题
状态：进行中
时间：2026-11-14

正文 Markdown
```

- 第一行固定 `类型：标题`；有 `status` 才加 `状态：…`；有 `time` 才加 `时间：…`；
  然后**空行 + 正文**（`content` 非空时）。
- `done` / 标签 / 主题 / 阶段归属 / 版本历史 / 里程碑 **都不进 JSON Canvas**。

⚠️ **字段名的语言是个混合体**（源码如此，英文界面实测如下）：

| 行 | 中文界面 | 英文界面 |
|---|---|---|
| 第一行 | `目标：把项目做完` | `Goal: 把项目做完` ← 模板 `'{type}：{title}'` 的英文词条是 `'{type}: {title}'`，类型名是 `Goal` |
| 状态行 | `状态：进行中` | `Status: In progress` ← 模板 `'状态：{s}'` 有英文词条 |
| 时间行 | `时间：2026-11-14` | `Time: 2026-11-14` ← 模板 `'时间：{time}'` 有英文词条 |

- 也就是说：**第一行的字段名永远是中文冒号形式，后两行的字段名跟着界面语言变**。
  这与源码注释里"结构是数据契约、只有显示名走 `t()`"的说法并不完全一致
  （`状态：` / `时间：` 这两个字段名本身也走了 `t()`）。
  **按行解析的导入器必须容忍这一点。**
- 状态值是**显示值**（`statusLabel()`），英文界面是 `In progress` 而不是 `进行中`。


⚠️ **两个已知偏差**：

1. **group 节点用的是 `text` 字段，而不是 JSON Canvas 规范里 group 的 `label` 字段。**
   ⇒ 主题 / 阶段的标题在 Obsidian 里的具体显示效果**待确认**（见 §15）。
2. **边的过滤条件是"至少一端在导出范围内"**（`ids.has(fromId) || ids.has(toId)`），
   所以**可能留下指向未导出节点的边**（另一端 id 在文件里不存在）。

### 12.4 三种格式的往返保真度

| 数据 | JSON bundle | Markdown | JSON Canvas |
|---|---|---|---|
| 点 id / 类型 / 标题 / 正文 | ✅ | ✅ | ⚠️ 挤进 `text`（仅标题+状态+时间+正文） |
| `status` / `time` / `tags` | ✅ | ✅（⚠️ `status` 是**显示值**，可能已翻译） | ⚠️ 仅 `status` / `time`（显示值）；`tags` 丢失 |
| `done` | ✅ | ⚠️ 变成删除线 | ❌ |
| 坐标 / 尺寸 | ✅ | ❌ | ✅ |
| 封面图 `imageData` | ✅ | ✅（dataURL 内嵌） | ❌ |
| 封面图 `imageUrl` / `linkUrl` / `linkLabel` | ✅ | ✅ | ❌ |
| `themeIds` / `stageIds` | ✅ | ⚠️ 变成章节归属（语义近似） | ⚠️ 变成 group 节点（无归属关系） |
| 关系类型 / 方向 | ✅ | ⚠️ 变成 `→ 支持 X` 文本 | ⚠️ 变成 `label` 文本（类型被翻译成显示名） |
| 关系 `note` | ✅ | ✅ | ✅（拼进 label） |
| 主题 / 阶段实体（`name` / `color` / `start` / `end` / `description` / `parentId`） | ✅ | ⚠️ 只剩名字（+ 阶段的日期区间） | ⚠️ 只剩名字 |
| 里程碑 | ✅ | ❌ | ❌ |
| 版本历史（完整快照） | ✅ | ⚠️ 只有日期 + 原因 + 里程碑名 | ❌ |
| 自定义状态 | ✅ | ❌ | ❌ |
| 空间（`spaceId`） | ✅ | ❌ | ❌ |
| **字段原值 vs 显示值** | ✅ **全是原值** | ⚠️ 类型名 / 状态名 / 关系名是**显示值** | ⚠️ 同左 |
| **可导回本应用** | ✅ **可以** | ❌ 不行 | ❌ 不行 |

一句话：**只有 JSON bundle 能无损导回。** Markdown 与 JSON Canvas 都是单向出口。

---

## 13. 导入

- **只支持 JSON bundle**。导入入口只接受 `application/json` / `.json` 文件。
  Markdown 与 JSON Canvas **无法导入**。
- **导入语义：全量覆盖，不是合并。**
  - 先弹确认框：`导入 {name} 会覆盖当前全部数据。确定？`（按钮「覆盖导入」）。
  - 确认后：`repo.replaceAll(lib)`（清空 6 张表 + `customStatuses` 再写回）
    → `store.replaceLibrary(lib)` → 重建搜索索引 → 清空焦点。
  - **不会**按 id 去重、**不会**保留原库数据、**不会**做字段级合并。

### 13.1 校验规则（`fromBundle`）

| 检查 | 行为 |
|---|---|
| `library` 存在 | 否则抛错 `不是有效的人生画布导出文件` |
| `library.nodes` 是数组 | 否则抛错（同上） |
| `library.edges` 缺失 | 补 `[]` |
| `library.themes` 缺失 | 补 `[]` |
| `library.stages` 缺失 | 补 `[]` |
| `library.versions` 缺失 | 补 `[]` |
| `library.milestones` 缺失 | 补 `[]` |
| `library.customStatuses` 缺失 | 补 `[]` |
| `meta.schema` / `meta.version` | **不检查、不迁移** |
| 引用完整性（边指向不存在的点等） | **不检查** |
| 单条实体的字段合法性 | **不校验** |

### 13.2 ⚠️ 未知字段会被原样保留

`fromBundle` **不做字段白名单过滤**：它把 `library.nodes` 等数组**原封不动**交给 store。
于是：

- 文件里多出来的字段会**留在内存对象上**；
- 再导出时（`toBundle` 直接序列化整个 `library`）**会原样写回**；
- 落库时也会随 payload 一起加密保存。

⇒ **导入器可以自由携带自定义字段**，它们会被完整保留并往返。
这是有意可利用的扩展点（社区自定义字段不会被本应用抹掉）。
⚠️ 但反过来：**老版本 App 打开新版本导出的文件时，不认识的字段也会原样带着**，
而老版本的写入逻辑如果整对象覆盖，可能把新字段抹掉 —— 加字段时务必遵守 §14 的规矩。

---

## 14. 改格式的规矩

### 14.1 三种改法，分别怎么做

| 改法 | 判定 | 该怎么做 |
|---|---|---|
| **加字段**（可选、有默认值） | 新旧 App 都能读 | ① 直接加；② 读取端一律用 `?? 默认值` 兜底；③ **不要**把它加进 `SNAPSHOT_FIELDS`（除非你确实想为它建版本）；④ 写 `package.json` 版本 + `EXPORT_VERSION` |
| **加字段**（必填 / 无默认值） | 老库没有这个值 | 走**schema 升级**：Dexie `version(N+1)` + `meta` 标记 + 应用层迁移函数（见 §14.2） |
| **改字段名** | 等价于「删一个 + 加一个」 | **必须**有迁移函数。旧库里是旧名、新代码读新名 ⇒ 不迁移就是静默丢数据。绝不允许只改一处 |
| **删字段** | 老库里还有这个值 | ① **先停止写入**（代码里不再生成该字段）；② 读取端**继续能读**旧值（至少留一个发布周期）；③ 老库里的残留值在导出时会被原样带出（见 §13.2）⇒ 想要"干净"必须配迁移函数主动清理 |

### 14.2 schema 版本怎么升

1. `this.version(N + 1).stores({ ... })` —— **Dexie 的 `stores()` 是全量声明**：
   必须把**所有表**的 schema 重新写一遍（照抄上一版再改），漏掉的表会被删掉。
2. **纯新增表** → 不需要 `upgrade` 回调。
3. **要改数据** → **不能在 `upgrade` 回调里做**（没有 key，解不开密文）：
   - 在 `upgrade` 里只写 `meta.pendingSchemaMigration = <版本号>`；
   - 在**应用层**（拿到 key 之后、读库之前）跑迁移函数；
   - 迁移函数必须**幂等**，失败**保留标记**下次重试，成功**清标记**。
4. 迁移函数写在 `Repository.runSchemaMigration()` 一处，不要散落。

### 14.3 导出格式版本怎么升

- `EXPORT_VERSION`（`src/persist/export.ts`）是**导出格式**的版本号，与 `package.json` 的应用版本**无关**。
- `meta.schema` 是**结构版本**，目前恒为 `1`。
- ⚠️ `fromBundle` **不检查这两个号** ⇒ 导入旧文件不会被拒绝，也不会被迁移。
  这意味着：**兼容性责任全在导出侧**（写新字段前得先想清楚老 App 读不读得懂）。

### 14.4 兼容性承诺

| 方向 | 承诺 |
|---|---|
| **旧 App 读新库** | 只承诺**加法**：新增表、新增可选字段一般可读。**改必填字段、删字段、改字段名都会让旧 App 出错**（读不到值 ⇒ 行为未定义） |
| **新 App 读旧库** | 必须保证：迁移**只增不减**、**幂等**、失败可重试；新增字段必须有默认值 |
| **新 App 读新文件** | JSON bundle **无损**（含未知字段往返） |
| **旧 App 读新文件** | 新字段会被**原样忽略并保留**，不报错（除非旧 App 的写入逻辑整对象覆盖，见 §13.2） |
| **不可接受的改动** | 改 `id` 生成规则（会让历史引用断链）· 改 `spaceId` 规则（会让旧库的空间解析失败）· 把 `status` 的中文值翻译掉（会弄坏老库的筛选、配色、导出）· 把 `themeIds` / `stageIds` 降级成 `belong` 边（等于丢字段） |

### 14.5 几条"别踩"的硬约定

- **`status` 的值永远是中文原文**，只有显示走 `t()`。翻译它 = 数据迁移。
- **标签同理**：普通标签是用户内容不翻译；`周复盘` / `日记` 只翻译显示名。
- **归属的权威字段永远是 `themeIds` / `stageIds`**，`belong` 边永远不落库。
- **`spaceId` 永远是 `default` 或 `week:<周一>`**，不是周一就是坏 id。
- **`Version.snapshot` 里的键集合由 `SNAPSHOT_FIELDS` 唯一定义**，别在别处再抄一份。
- **加密开启时不要往行级加新的明文列**：那等于扩大泄漏面（已知泄漏：id / spaceId / updatedAt / 点类型）。

---

## 15. 已知偏差与待确认

### 15.1 源码与旧文档的偏差（以源码为准）

| 旧文档 | 现状 |
|---|---|
| 早期设计稿里的 `Node.areaIds` | 已改为 `themeIds` + `stageIds` |
| 早期设计稿里的 `Area` 实体 | 已拆成 `LifeTheme` + `LifeStage`；`area` 仅存于迁移内部 |
| 早期设计稿里的 `Tag` / `Attachment` 实体 | 已不存在：标签是 `string[]`，图片是 `imageData` / `imageUrl` |
| 早期设计稿里的 `EDGE_CONSTRAINTS`（含 `belong`） | `belong` 已移出约束表 |
| 早期设计稿里的存储 schema | 已是 v4，且表结构已改成 `Row` + `payload` 加密模型 |

### 15.2 待确认

| # | 事项 | 状态 |
|---|---|---|
| 1 | JSON Canvas 的 group 节点用 `text`（非规范的 `label`）在 Obsidian 里的**具体渲染表现** | 源码行为已确认；Obsidian 渲染效果**未实测** |
| 2 | 导出的 `.json` 画布文件被 Obsidian **完整接受**（不报格式错） | **未实测** |
| 3 | IndexedDB 运行时版本号 `db.verno === 4` | Dexie 声明确认为 `version(1..4)`；**未在浏览器里读 `db.verno`** |
| 4 | `versions` 表 `spaceId` / `updatedAt` 恒为 `undefined`（索引空）的**实际性能影响** | 写入路径已逐行确认；**未做性能实测** |
| 5 | 「导入保留未知字段」是否属于**有意设计** | 源码无相关注释；行为已确认，**意图未确认** |
| 6 | Markdown 导出里**无主题无阶段**的点被完全省略，是否与产品预期一致 | 行为已确认；**未确认是否有意** |
| 7 | 导出正文里的字段名（`状态：` / `时间：`）随界面语言变，是有意设计还是漏翻 | 行为已逐条核对文案表：**中英文都有词条**，不是漏翻；**意图未确认**。按行解析的导入器必须容忍 |
| 8 | JSON Canvas 的 group 用 `text` 而非规范的 `label`，是否会在 Obsidian 里丢标题 | 见 #1 |

---

## 附：一页速查

```text
库名      life-canvas          schema v4        表 8 张
点类型    goal event emotion idea person resource action reflect place work
关系类型  belong(不可手工连) support block cause replace reference conflict inspire sequence
归属权威  node.themeIds / node.stageIds        belong 边永不落库
空间      default | week:<周一 YYYY-MM-DD>
版本快照  title content status time tags type   其余字段不进版本历史
加密      AES-GCM-256 / PBKDF2-SHA256 600k      明文：id spaceId updatedAt type
导出      JSON bundle(可往返) · Markdown(单向) · JSON Canvas(单向)
导入      只收 JSON bundle · 语义 = 全量覆盖
```
