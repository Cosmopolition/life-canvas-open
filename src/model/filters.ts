/**
 * 筛选（需求文档 8.5）。
 *
 * 设计约定：**筛选是覆盖全图的透镜，搜索在透镜内进行。**
 * 而不是"先搜再筛" —— 那会让用户搜到一个看不见的点。
 */
import { GOAL_STATUS, statusLabel, tagLabel, type Library, type LifeNode, type NodeType } from './types';
import { t } from '../i18n';

export interface FilterState {
  /** 目标状态（仅对 type === 'goal' 的点有意义） */
  statuses: Set<string>;
  /** 标签 */
  tags: Set<string>;
  /** 时间范围，含端点；空字符串表示不限 */
  from: string;
  to: string;
}

export const emptyFilter = (): FilterState => ({
  statuses: new Set(), tags: new Set(), from: '', to: '',
});

export function isFilterActive(f: FilterState): boolean {
  return f.statuses.size > 0 || f.tags.size > 0 || !!f.from || !!f.to;
}

export function filterCount(f: FilterState): number {
  return f.statuses.size + f.tags.size + (f.from ? 1 : 0) + (f.to ? 1 : 0);
}

/** 'YYYY-MM' 或 'YYYY-MM-DD' → 'YYYY-MM'；无法解析时返回 undefined */
export function monthOf(t: string | undefined): string | undefined {
  if (!t) return undefined;
  const m = /^(\d{4})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}` : undefined;
}

/**
 * 单点是否通过筛选。
 * 无时间的点（如"想法"）不受时间范围限制 —— 否则一旦设了时间，
 * 所有没写日期的记录会集体消失，这是个陷阱。
 */
export function passes(n: LifeNode, f: FilterState): boolean {
  if (f.statuses.size) {
    // 只有目标是状态过滤的适用对象；非目标点在设了状态过滤时一律不通过
    if (n.type !== 'goal' || !n.status || !f.statuses.has(n.status)) return false;
  }
  if (f.tags.size) {
    for (const t of f.tags) if (!n.tags.includes(t)) return false;
  }
  if (f.from || f.to) {
    const m = monthOf(n.time);
    if (m) {
      if (f.from && m < f.from) return false;
      if (f.to && m > f.to) return false;
    }
  }
  return true;
}

export function applyFilter(lib: Library, f: FilterState, types: ReadonlySet<NodeType> | null): LifeNode[] {
  return lib.nodes.filter((n) => {
    if (types && types.size && !types.has(n.type)) return false;
    return passes(n, f);
  });
}

/** 全库出现过的标签，按使用次数降序 */
export function allTags(lib: Library): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const n of lib.nodes) for (const t of n.tags) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** 全库出现过的目标状态，内置的在前，自定义按 order 在后 */
export function allStatuses(lib: Library): string[] {
  const builtin: readonly string[] = GOAL_STATUS;
  const seen = new Set<string>();
  for (const n of lib.nodes) if (n.type === 'goal' && n.status) seen.add(n.status);
  const custom = [...seen].filter((s) => !builtin.includes(s));
  return [...builtin.filter((s) => seen.has(s) || builtin.includes(s)), ...custom];
}

/** 时间轴可用的月份范围 */
export function monthRange(lib: Library): string[] {
  const set = new Set<string>();
  for (const n of lib.nodes) { const m = monthOf(n.time); if (m) set.add(m); }
  return [...set].sort();
}

/** 一句话描述当前筛选，用于面包屑 */
export function describe(f: FilterState): string[] {
  const out: string[] = [];
  if (f.statuses.size) out.push(t('field.statusList', { list: [...f.statuses].map(statusLabel).join(' / ') }));
  if (f.tags.size) out.push(t('field.tagsValue', { list: [...f.tags].map((x) => '#' + tagLabel(x)).join(' ') }));
  if (f.from) out.push(t('timeline.fromDate', { date: f.from }));
  if (f.to) out.push(t('timeline.toDate', { date: f.to }));
  return out;
}