/**
 * **数据契约** —— 落库的值 ↔ 显示名。
 *
 * ⚠️ 为什么单独一个文件：
 *   `node.status` 里存的就是 '进行中' 这样的中文字符串，用户的库里已经躺着一堆了。
 *   翻译它等于数据迁移 —— 会把老库的筛选、配色、导出全部弄坏。
 *
 *   所以规矩是：**存进库的永远是原值，显示时才查表翻译**。
 *   这张表就是"原值 → 显示名"的那一步。
 *
 *   这里的每个键都指向 strings.ts 里的一个 slug —— 显示名本身在那边查。
 *
 * 依赖方向：只 import **类型**（model/types 的 NodeType / EdgeType），
 *   不 import 任何运行时值 —— model/types 也要 import 本目录，
 *   运行时 import 会成环。
 */
import type { EdgeType, NodeType } from '../model/types';
import type { StringKey } from './strings';

/* ---------- 点类型 ---------- */
/**
 * 点类型码（'goal' / 'event'…）→ 显示名。
 *
 * 码本身是英文的（不随语言变），中文只是显示名。
 */
export const NODE_TYPE_KEY: Record<NodeType, StringKey> = {
  goal: 'nodeType.goal',
  event: 'nodeType.event',
  emotion: 'nodeType.emotion',
  idea: 'nodeType.idea',
  person: 'nodeType.person',
  resource: 'nodeType.resource',
  action: 'nodeType.action',
  reflect: 'nodeType.reflect',
  place: 'nodeType.place',
  work: 'nodeType.work',
};

/* ---------- 线类型 ---------- */
export const EDGE_TYPE_KEY: Record<EdgeType, StringKey> = {
  belong: 'edgeType.belong',
  support: 'edgeType.support',
  block: 'edgeType.block',
  cause: 'edgeType.cause',
  replace: 'edgeType.replace',
  reference: 'edgeType.reference',
  conflict: 'edgeType.conflict',
  inspire: 'edgeType.inspire',
  sequence: 'edgeType.sequence',
};

/* ---------- 目标状态 ---------- */
/**
 * 目标状态值（'进行中'…）→ 显示名。
 *
 * ⚠️ 键是**落库的原值**。用户自建的状态不在表里 —— 原样显示，不翻译。
 */
export const STATUS_KEY: Record<string, StringKey> = {
  '无目标': 'status.noGoal',
  '想法': 'status.idea',
  '探索中': 'status.exploring',
  '进行中': 'status.inProgress',
  '已完成': 'status.completed',
  '搁置': 'status.onHold',
  '放弃': 'status.abandoned',
  '已取代': 'status.replaced',
};

/* ---------- 系统标签 ---------- */
/**
 * 系统标签（'周复盘' / '日记'）→ 显示名。
 *
 * ⚠️ 只有系统自带的这两个标签在表里；普通标签是用户自己的内容，不翻译。
 */
export const TAG_KEY: Record<string, StringKey> = {
  '周复盘': 'tag.weeklyReview',
  '日记': 'tag.diary',
};

/* ---------- 星期 ---------- */
/** 星期几（'周一'…）→ 显示名。 */
export const WEEKDAY_KEY: Record<string, StringKey> = {
  '周一': 'weekday.mon',
  '周二': 'weekday.tue',
  '周三': 'weekday.wed',
  '周四': 'weekday.thu',
  '周五': 'weekday.fri',
  '周六': 'weekday.sat',
  '周日': 'weekday.sun',
};

/* ---------- 里程碑状态 ---------- */
/** 里程碑状态码 → 显示名。 */
export const MILESTONE_KEY: Record<string, StringKey> = {
  pending: 'milestone.pending',
  overdue: 'milestone.overdue',
  completed: 'milestone.completed',
  'completed-early': 'milestone.completedEarly',
  'completed-late': 'milestone.completedLate',
};
