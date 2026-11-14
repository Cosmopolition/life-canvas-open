/**
 * 全部实体定义 —— 本项目的单一真相源。
 * 见 docs/DATA-FORMAT.md
 */
import { t } from '../i18n';
import { EDGE_TYPE_KEY, NODE_TYPE_KEY, STATUS_KEY, TAG_KEY } from '../i18n/contracts';

export type ID = string;

/* ---------- 点类型 ---------- */
export const NODE_TYPES = [
  'goal', 'event', 'emotion', 'idea', 'person',
  'resource', 'action', 'reflect', 'place', 'work',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/**
 * 点类型名（**显示用**，随界面语言变）。
 *
 * 显示名走 i18n 契约表（src/i18n/contracts.ts）—— 点类型码本身是英文的
 * （'goal' / 'event'…），不随语言变，中文只是显示名。
 */
export function nodeTypeLabel(type: NodeType): string {
  return t(NODE_TYPE_KEY[type]);
}

/** 每种点类型一个稳定色，UI 与导出共用 */
export const NODE_TYPE_COLOR: Record<NodeType, string> = {
  goal: '#d99a4e', event: '#7f9bd4', emotion: '#b98ac9', idea: '#c9a86a',
  person: '#6fae8f', resource: '#b0a58c', action: '#8a9a86', reflect: '#8f8fd4',
  place: '#c98a8a', work: '#d47f9a',
};

/* ---------- 目标状态 ---------- */
export const GOAL_STATUS = [
  '无目标', '想法', '探索中', '进行中', '已完成', '搁置', '放弃', '已取代',
] as const;
export type GoalStatus = (typeof GOAL_STATUS)[number] | (string & {});

export const BUILTIN_STATUS: readonly string[] = GOAL_STATUS;

export const STATUS_COLOR: Record<string, string> = {
  '进行中': '#e0a458', '探索中': '#c9a86a', '已完成': '#6fae8f',
  '已取代': '#626a79', '搁置': '#626a79', '放弃': '#8b93a1',
};

/**
 * 目标状态的显示名（随界面语言变）。
 *
 * ⚠️ **状态值本身是数据，不能翻译**：`node.status` 存的就是 '进行中' 这样的中文字符串，
 * 用户的库里已经躺着一堆了。翻译它等于数据迁移，会把老库的筛选、配色、导出全部弄坏。
 * 所以这里只翻译**显示**，存进库的永远是原值。
 *
 * 自定义状态（用户自己起的）没有对照表，原样显示。
 */
export function statusLabel(status: string): string {
  const key = STATUS_KEY[status];
  return key ? t(key) : status;
}

/**
 * 系统标签的显示名。普通标签是用户自己的内容，不翻译。
 */
export function tagLabel(tag: string): string {
  const key = TAG_KEY[tag];
  return key ? t(key) : tag;
}

/* ---------- 线类型 + 关系约束 ---------- */
export const EDGE_TYPES = [
  'belong', 'support', 'block', 'cause', 'replace', 'reference', 'conflict', 'inspire', 'sequence',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** 线类型名（显示用，随界面语言变）。 */
export function edgeTypeLabel(type: EdgeType): string {
  return t(EDGE_TYPE_KEY[type]);
}

export const EDGE_TYPE_COLOR: Record<EdgeType, string> = {
  belong: '#626a79', support: '#6fae8f', block: '#e06a6a', cause: '#c9a86a',
  replace: '#e0a458', reference: '#7f9bd4', conflict: '#d47f9a',
  inspire: '#b98ac9', sequence: '#8b93a1',
};

/**
 * 实体种类。
 * - 'node'：点
 * - 'theme'：长期主题（事业、身心健康 ……）。可嵌套。
 * - 'stage'：时段（2023-2025 星河、2026 过渡期 ……）。平级，可带 start/end 时间范围。
 * - 'area'：旧版 LifeArea 的 kind。**仅 runSchemaMigration 内部使用**——
 *   迁移完成后数据库里不应再有 area 实体。约束（EDGE_CONSTRAINTS）不接受
 *   手工新建 area 边，所以普通连线流程不会引入新 'area' 引用。
 */
export type EntityKind = 'node' | 'theme' | 'stage' | 'area';

export interface EdgeConstraint {
  from: readonly EntityKind[];
  to: readonly EntityKind[];
  /** 若指定，则"起点"必须是这些点类型之一 */
  fromNodeTypes?: readonly NodeType[];
  symmetric: boolean;
}

/**
 * 可执行的关系约束。连线拖拽时用它高亮合法目标（见 docs/DATA-FORMAT.md 的关系约束表）。
 * 注意 belong（属于）不出现在这里 —— 归属由 Node.themeIds/stageIds 权威持有，
 * 画布上的"属于"边是自动派生的投影，不存储、不参与这里的手工连线。
 */
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

/** 某个 (线类型, 起点类型) 下，合法目标集合的判定 */
export function canConnect(type: EdgeType, from: { kind: EntityKind; type?: NodeType }, toKind: EntityKind): boolean {
  if (type === 'belong') return false; // 归属不通过手工连线建立
  const c = EDGE_CONSTRAINTS[type];
  if (!c) return false;
  if (!c.from.includes(from.kind)) return false;
  if (!c.to.includes(toKind)) return false;
  if (c.fromNodeTypes && from.type && !c.fromNodeTypes.includes(from.type)) return false;
  return true;
}

/* ---------- 实体 ---------- */
interface Base {
  id: ID;
  /** 见 §5.3：第一版只有 default，但字段必须从第一天存在 */
  spaceId: ID;
  createdAt: number;
  updatedAt: number;
}

export interface LifeNode extends Base {
  kind: 'node';
  type: NodeType;
  title: string;
  content: string;
  status?: GoalStatus;
  /**
   * 是否已完成 —— 当前主要用于 action（软安排）。其他类型设了也无所谓，
   * 只是没渲染。goals 走自己的 status 状态机（进行中/已取代/...），不混。
   * 不入版本历史（轻量状态，不是"内容修改"）。
   */
  done?: boolean;
  /** 'YYYY-MM' | 'YYYY-MM-DD'，可选。不建独立时间实体（AD-11） */
  time?: string;
  tags: string[];
  /** 主题归属。画布上的"属于"边由此派生，不存储。 */
  themeIds: ID[];
  /** 阶段归属。显式 stageIds ∪ 时基命中（见 selectors.inStage）。 */
  stageIds: ID[];
  /** 全局坐标，不属于任何面（§1 约束 1） */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * 节点封面图（base64 dataURL）。可选 —— 任意类型都可贴图，存进加密库。
   * 渲染时缩到 ≤120px 显示在节点框左侧，标题从图右边开始。
   * imageW/imageH 是图被收入时缩到 ≤800px 后的自然像素尺寸，导出/缩放时直接用。
   */
  imageData?: string;
  imageW?: number;
  imageH?: number;
  /**
   * 节点封面图（外链 URL）。优先级低于 imageData。
   * 体积 0 但不持久（换设备/重置即丢），适合"先用网上的图占位、以后再下载入库"。
   * 加载失败/跨域时降级为占位底色。
   */
  imageUrl?: string;
  /**
   * 节点关联的任意文档链接（网页/wiki/PDF/Notion 等）。与封面图无关。
   * ⌘+点击节点时打开。linkLabel 可选，Markdown 导出时用作文本。
   */
  linkUrl?: string;
  linkLabel?: string;
  /**
   * 引入自哪个节点（周画布里从主画布复制过来的副本）。
   *
   * 可选 —— 不填就是普通节点。有它才能「回原文」跳回源头。
   * ⚠️ 不进版本历史（跟 action.done 同档：来源是结构信息，不是"内容修改"）。
   */
  sourceId?: ID;
}

export interface LifeEdge extends Base {
  kind: 'edge';
  fromId: ID;
  fromKind: EntityKind;
  toId: ID;
  toKind: EntityKind;
  type: EdgeType;
  note?: string;
}

/**
 * 长期主题。一个长期的关注领域（事业、身心健康 ……）。
 * 可嵌套（事业 > 工程），name 在同级内不必唯一。
 */
export interface LifeTheme extends Base {
  kind: 'theme';
  name: string;
  parentId: ID | null;
  color: string;
  description?: string;
}

/**
 * 时段。带 start?/end?（YYYY-MM）的"人生某一截"。
 * 平级（不嵌套）；节点既可以通过 stageIds 显式归属，
 * 也可以在 time 落在 [start, end] 内时被自动算入。
 * start/end 可只设一边；start > end 视为无效（防御性，不自动交换）。
 */
export interface LifeStage extends Base {
  kind: 'stage';
  name: string;
  color: string;
  start?: string;
  end?: string;
  description?: string;
}

export interface Version {
  id: ID;
  nodeId: ID;
  /** 节点全字段快照（不含坐标），JSON 字符串 */
  snapshot: string;
  /** 非空 = 手动标记的里程碑 */
  title?: string;
  /** 必填。没有原因的版本历史只是一堆旧值 */
  reason: string;
  changedAt: number;
  changedFields: string[];
}

export interface CustomStatus {
  id: ID;
  name: string;
  /** 排在所有内置状态之后 */
  order: number;
}

/**
 * 里程碑（goal 的时间点位检查清单）
 * - 只挂在 `type === 'goal'` 的节点下
 * - 当前是 pending 还是 overdue 等**衍生状态**，由 `milestoneDisplay` 现算，不入库
 * - 不入版本历史（与 `action.done` 同档 —— 勾掉是状态，不是"内容修改"）
 * - 删除 goal 时，store.removeNode 会清掉 parentId === id 的所有 milestone，避免僵尸数据
 */
export interface Milestone extends Base {
  kind: 'milestone';
  parentId: ID;
  title: string;
  /** YYYY-MM-DD 计划完成日 */
  targetDate: string;
  /** YYYY-MM-DD 实际完成日；未设置 = 待办 */
  completedAt?: string;
  /** 展示顺序 —— addMilestone 自动 +1，用户拖拽时可改 */
  order: number;
}

/* ---------- 空间 ---------- */
export const DEFAULT_SPACE = 'default';

/* ---------- 库 ---------- */
export interface Library {
  nodes: LifeNode[];
  edges: LifeEdge[];
  themes: LifeTheme[];
  stages: LifeStage[];
  milestones: Milestone[];
  versions: Version[];
  customStatuses: CustomStatus[];
}

export const emptyLibrary = (): Library => ({
  nodes: [], edges: [],
  themes: [], stages: [],
  milestones: [],
  versions: [], customStatuses: [],
});

export const uid = (p = ''): ID =>
  p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- 节点尺寸的边界 ---------- */

/**
 * 节点的最小尺寸（缩放手柄拖不到比这更小）。
 *
 * 放在类型定义这一层 —— 画布拖拽（canvas 层）和落库（model 层）
 * 都按它夹，规则只有一份。
 */
export const MIN_NODE_W = 120;
export const MIN_NODE_H = 56;
