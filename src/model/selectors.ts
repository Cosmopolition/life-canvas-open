/**
 * 派生查询。纯函数，不持有状态 —— 全部可以从 Library 重新算出来。
 * 见 docs/ARCHITECTURE.md §2（model 层不依赖任何上层）
 */
import type {
  EntityKind, ID, LifeEdge, LifeNode, LifeStage, LifeTheme, Library, Milestone, NodeType,
} from './types';
import { t } from '../i18n';
import { MILESTONE_KEY } from '../i18n/contracts';

export const byId = <T extends { id: ID }>(arr: readonly T[], id: ID): T | undefined =>
  arr.find((x) => x.id === id);

/* ============================================================
 * 主题 / 阶段 派生
 * ============================================================ */

/* ============================================================
 * 主题 / 阶段（新 API）
 * ============================================================ */

/** 主题 → 从该主题到根的路径（根在前）。跨 kind 的 parentId 跳过。 */
export function themeChain(lib: Library, id: ID | null): LifeTheme[] {
  const out: LifeTheme[] = [];
  let cur = id ? byId(lib.themes, id) : undefined;
  const guard = new Set<ID>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? byId(lib.themes, cur.parentId) : undefined;
  }
  return out;
}

/** 阶段：平级（无 parentId），链只有自己 */
export function stageChain(lib: Library, id: ID | null): LifeStage[] {
  if (!id) return [];
  const s = byId(lib.stages, id);
  return s ? [s] : [];
}

/** 该点是否落在指定主题内（含所有子主题） */
export function inTheme(lib: Library, node: LifeNode, themeId: ID): boolean {
  for (const t of node.themeIds) {
    if (themeChain(lib, t).some((x) => x.id === themeId)) return true;
  }
  return false;
}

/**
 * 该点是否落在指定阶段内。
 * 命中条件（任一即可）：
 *   1. 显式 stageIds 包含
 *   2. node.time（截断为 YYYY-MM）落在 stage 的 [start?, end?] 闭区间内
 * 防御：start & end & start &gt; end → 视为无时基成员（不抛错、不自动交换）。
 */
export function inStage(lib: Library, node: LifeNode, stageId: ID): boolean {
  if (node.stageIds.includes(stageId)) return true;
  const s = byId(lib.stages, stageId);
  if (!s) return false;
  if (s.start && s.end && s.start > s.end) return false;
  const m = monthOf(node.time);
  if (!m) return false;
  if (s.start && m < s.start) return false;
  if (s.end && m > s.end) return false;
  return true;
}

/**
 * 多维焦点可见节点：双焦点交集。
 * - themeId = null → 不按主题过滤
 * - stageId = null → 不按阶段过滤
 * - 都 null → 全部
 * - 都设 → inTheme &amp;&amp; inStage
 */
export function visibleNodesByFocus(
  lib: Library,
  themeId: ID | null,
  stageId: ID | null,
  types?: ReadonlySet<NodeType>,
): LifeNode[] {
  return lib.nodes.filter((n) => {
    if (types && types.size && !types.has(n.type)) return false;
    if (themeId && !inTheme(lib, n, themeId)) return false;
    if (stageId && !inStage(lib, n, stageId)) return false;
    return true;
  });
}

/**
 * 主题 → 节点。带版本缓存：侧栏、areaBox（改名后叫 themeBox）、命中过滤都会反复调它。
 */
const themeCache = new Map<ID, { rev: number; nodes: LifeNode[]; all: LifeNode[] }>();

export function nodesInTheme(lib: Library, themeId: ID, includeDescendants: boolean): LifeNode[] {
  let slot = themeCache.get(themeId);
  if (!slot || slot.rev !== revision) {
    const direct = lib.nodes.filter((n) => n.themeIds.includes(themeId));
    const ids = new Set(
      lib.themes
        .filter((a) => themeChain(lib, a.id).some((x) => x.id === themeId))
        .map((a) => a.id)
    );
    const all = lib.nodes.filter((n) => n.themeIds.some((t) => ids.has(t)));
    slot = { rev: revision, nodes: direct, all };
    themeCache.set(themeId, slot);
  }
  return includeDescendants ? slot.all : slot.nodes;
}

/**
 * 阶段 → 节点。显式 stageIds ∪ 时基命中。带版本缓存。
 * 阶段是平级，includeDescendants 参数保留接口形状（语义上无影响）。
 */
const stageCache = new Map<ID, { rev: number; nodes: LifeNode[] }>();

export function nodesInStage(lib: Library, stageId: ID): LifeNode[] {
  let slot = stageCache.get(stageId);
  if (!slot || slot.rev !== revision) {
    const s = byId(lib.stages, stageId);
    let nodes: LifeNode[];
    if (!s) {
      nodes = [];
    } else {
      const explicit = lib.nodes.filter((n) => n.stageIds.includes(stageId));
      const invalid = !!(s.start && s.end && s.start > s.end);
      const byTime = invalid ? [] : lib.nodes.filter((n) => {
        const m = monthOf(n.time);
        if (!m) return false;
        if (s.start && m < s.start) return false;
        if (s.end && m > s.end) return false;
        return true;
      });
      const seen = new Set<ID>();
      const merged: LifeNode[] = [];
      for (const n of [...explicit, ...byTime]) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        merged.push(n);
      }
      nodes = merged;
    }
    slot = { rev: revision, nodes };
    stageCache.set(stageId, slot);
  }
  return slot.nodes;
}

/** 实体下标：连线合法性判定要用 */
export function entityKind(lib: Library, id: ID): EntityKind | undefined {
  if (byId(lib.nodes, id)) return 'node';
  if (byId(lib.themes, id)) return 'theme';
  if (byId(lib.stages, id)) return 'stage';
  return undefined;
}

export function entityType(lib: Library, id: ID): NodeType | undefined {
  return byId(lib.nodes, id)?.type;
}

/* ============================================================
 * 里程碑（goal 的时间点位检查清单）
 * ============================================================ */

/** 今天：YYYY-MM-DD —— 新建 milestone 时作默认 targetDate 用 */
export const todayKey = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 目标节点下的全部里程碑，按 order 升序 */
export function milestonesOf(lib: Library, parentId: ID): Milestone[] {
  return lib.milestones
    .filter((m) => m.parentId === parentId)
    .sort((a, b) => a.order - b.order);
}

/** 衍生状态：颜色与文案的源头。不存库，每次按 today 现算 */
export type MilestoneDisplay =
  | 'pending'         // 待办
  | 'overdue'         // 逾期未完成
  | 'completed'       // 已完成（按时完成）
  | 'completed-early' // 提前完成
  | 'completed-late'; // 逾期才完成

export function milestoneDisplay(m: Milestone, today: string): MilestoneDisplay {
  if (!m.completedAt) return m.targetDate < today ? 'overdue' : 'pending';
  if (m.completedAt < m.targetDate) return 'completed-early';
  if (m.completedAt > m.targetDate) return 'completed-late';
  return 'completed';
}

/** 衍生状态对应的视觉色 —— 检视面板状态点 / 后续画布指纹带共用 */
export const MILESTONE_COLOR: Record<MilestoneDisplay, string> = {
  'pending': '#626a79',
  'overdue': '#e06a6a',
  'completed': '#6fae8f',
  'completed-early': '#7fb88a',
  'completed-late': '#c9a86a',
};

/** 里程碑状态名（显示用，随界面语言变）。 */
export function milestoneLabel(d: MilestoneDisplay): string {
  return t(MILESTONE_KEY[d]!);
}

export interface Adjacency {
  out: LifeEdge[];
  in: LifeEdge[];
  all: LifeEdge[];
}

/**
 * 邻接索引：整图建一次，不是每次查询重扫全部边。
 * 原实现是 O(E)/次，expandOneHop 对 200 个命中各调一次 = 200 万次边遍历，
 * 1 万节点下直接把搜索延迟推到 200ms。
 */
interface AdjCache { rev: number; lib: Library; map: Map<ID, Adjacency> }

let revision = 0;
let adjCache: AdjCache | null = null;
let themeBelongCache: { rev: number; lib: Library; edges: { fromId: ID; toId: ID }[] } | null = null;
let stageBelongCache: { rev: number; lib: Library; edges: { fromId: ID; toId: ID }[] } | null = null;

/** 图结构变更时调用，使所有派生缓存失效 */
export const bumpRevision = (): void => {
  revision++;
  adjCache = null;
  themeBelongCache = null;
  stageBelongCache = null;
  themeCache.clear();
  stageCache.clear();
};

/**
 * 当前图结构版本号。
 *
 * 派生缓存（边的几何、邻接索引…）靠它判断自己是不是过期了。
 * 节点被拖动也会 bump（moveNode 走 emit('graph')），
 * 所以「位置变了」同样能被这个戳捕捉到。
 */
export const graphRevision = (): number => revision;

function adjIndex(lib: Library): Map<ID, Adjacency> {
  if (adjCache && adjCache.lib === lib && adjCache.rev === revision) return adjCache.map;
  const map = new Map<ID, Adjacency>();
  const get = (id: ID): Adjacency => {
    let a = map.get(id);
    if (!a) { a = { out: [], in: [], all: [] }; map.set(id, a); }
    return a;
  };
  for (const e of lib.edges) {
    const a = get(e.fromId); a.out.push(e); a.all.push(e);
    const b = get(e.toId); b.in.push(e); b.all.push(e);
  }
  adjCache = { rev: revision, lib, map };
  return map;
}

export function adjacencyOf(lib: Library, id: ID): Adjacency {
  return adjIndex(lib).get(id) ?? { out: [], in: [], all: [] };
}

export function neighborsOf(lib: Library, id: ID): Set<ID> {
  const s = new Set<ID>();
  for (const e of adjacencyOf(lib, id).all) {
    s.add(e.fromId === id ? e.toId : e.fromId);
  }
  return s;
}

/**
 * 一跳关系扩展：搜索命中后带出上下文（§7.3）。
 *
 * 注意：必须遍历"快照"而不是边遍历边往同一个 Set 里加 ——
 * JS 的 Set 迭代会访问迭代期间新增的元素，那样会一路递归成整个连通分量。
 */
export function expandOneHop(lib: Library, ids: Iterable<ID>): Set<ID> {
  const out = new Set<ID>(ids);
  const frontier = [...out];
  for (const id of frontier) {
    for (const n of neighborsOf(lib, id)) out.add(n);
  }
  return out;
}

export const replaceEdges = (lib: Library): LifeEdge[] => lib.edges.filter((e) => e.type === 'replace');

/** 目标取代链：返回按时间排序的目标节点 */
/**
 * 目标取代链：返回包含该点的完整链条，**按时间正序**。
 *
 * 先向后找到链尾，再向前补齐链头，最后按时间排序 ——
 * 直接从一个中间节点出发做 reverse() 会得到反的顺序。
 */
export function replaceChain(lib: Library, nodeId: ID): LifeNode[] {
  const edges = replaceEdges(lib);
  const next = new Map<ID, ID>();
  const prev = new Map<ID, ID>();
  for (const e of edges) {
    if (!next.has(e.fromId)) next.set(e.fromId, e.toId);
    if (!prev.has(e.toId)) prev.set(e.toId, e.fromId);
  }

  const forward: LifeNode[] = [];
  const seen = new Set<ID>();
  let cur: LifeNode | undefined = byId(lib.nodes, nodeId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id); forward.push(cur);
    const n = next.get(cur.id);
    cur = n ? byId(lib.nodes, n) : undefined;
  }

  const head: LifeNode[] = [];
  const seenBack = new Set<ID>([nodeId]);
  cur = byId(lib.nodes, nodeId);
  while (cur) {
    const p = prev.get(cur.id);
    const pn = p ? byId(lib.nodes, p) : undefined;
    if (!pn || seenBack.has(pn.id)) break;
    seenBack.add(pn.id); head.push(pn); cur = pn;
  }

  // 环状取代时 head 和 forward 可能重叠，去重后再排
  const uniq = new Map<ID, LifeNode>();
  for (const n of [...head, ...forward]) if (!uniq.has(n.id)) uniq.set(n.id, n);
  return [...uniq.values()].sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
}

/**
 * 与该节点相邻的"父目标"候选（详情画布专用）。
 *
 * 启发式：另一端是 goal 的边，去重；排除 replace（取代关系，非父子）。
 * 方向无关 —— action↔goal 在数据里既可能是 action→goal（support），也可能是 goal→action（cause / sequence）。
 * belong 不入库，自动不命中。theme / stage 不在 adj.all，双层防御。
 *
 * 按 time 升序；无 time 时按 id 字典序，保证稳定。
 */
export function parentGoalsOf(lib: Library, id: ID): LifeNode[] {
  const adj = adjacencyOf(lib, id);
  const out: LifeNode[] = [];
  const seen = new Set<ID>();
  for (const e of adj.all) {
    if (e.type === 'replace') continue;
    const otherId = e.fromId === id ? e.toId : e.fromId;
    if (seen.has(otherId)) continue;
    const n = byId(lib.nodes, otherId);
    if (n && n.type === 'goal') { seen.add(otherId); out.push(n); }
  }
  return out.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? '') || a.id.localeCompare(b.id));
}

/** 画布上"点 → 主题"虚边：由 themeIds 派生 */
export function derivedThemeBelongEdges(lib: Library): { fromId: ID; toId: ID }[] {
  if (themeBelongCache && themeBelongCache.lib === lib && themeBelongCache.rev === revision) return themeBelongCache.edges;
  const out: { fromId: ID; toId: ID }[] = [];
  for (const n of lib.nodes) for (const t of n.themeIds) out.push({ fromId: n.id, toId: t });
  themeBelongCache = { rev: revision, lib, edges: out };
  return out;
}

/** 画布上"点 → 阶段"虚边：显式 stageIds ∪ 时基命中（inStage） */
export function derivedStageBelongEdges(lib: Library): { fromId: ID; toId: ID }[] {
  if (stageBelongCache && stageBelongCache.lib === lib && stageBelongCache.rev === revision) return stageBelongCache.edges;
  const out: { fromId: ID; toId: ID }[] = [];
  for (const s of lib.stages) {
    for (const n of lib.nodes) if (inStage(lib, n, s.id)) out.push({ fromId: n.id, toId: s.id });
  }
  stageBelongCache = { rev: revision, lib, edges: out };
  return out;
}

export const nodeLabel = (n: LifeNode): string =>
  n.type === 'goal' ? `${n.title}` : n.title;

/** 主题路径展示：人生 / 事业（职业） */
export function themePath(lib: Library, id: ID | null): string {
  return themeChain(lib, id).map((t) => t.name).join(' / ');
}

/** 阶段路径展示：阶段是平级，只有名字 */
export function stagePath(lib: Library, id: ID | null): string {
  return stageChain(lib, id).map((s) => s.name).join(' / ');
}

/** 焦点路径：把两个焦点用 · 拼起来 */
export function focusPath(lib: Library, themeId: ID | null, stageId: ID | null): string {
  return [themePath(lib, themeId), stagePath(lib, stageId)].filter(Boolean).join(' · ');
}

/** 时间归一化到月，用于时间轴定位 */
export function monthOf(t: string | undefined): string | undefined {
  if (!t) return undefined;
  const m = /^(\d{4})-(\d{2})/.exec(t);
  return m ? `${m[1]}-${m[2]}` : undefined;
}

export function nodeMonth(n: LifeNode): string | undefined { return monthOf(n.time); }

/** 时间归一化到日（YYYY-MM-DD）。支持 '2026-10-12' 和 '2026-10-12T09:00' 两种写法 */
export function dayOf(t: string | undefined): string | undefined {
  if (!t) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  return m ? m[1] : undefined;
}

/**
 * 某日的「今日视图」数据：日记 reflect（取第一条）+ 软安排 action[]。
 * dayOf 不匹配的节点一律不进。
 *
 * 注意：diary 只取第一条 reflect —— 我们约定"一天一条日记节点"，
 * 但不强制（不校验），多条 reflect 同 time=今天 时只显示第一条并在检视面板里能看到其余。
 */
export function todayNodes(lib: Library, date: string): { diary: LifeNode | undefined; soft: LifeNode[] } {
  const soft: LifeNode[] = [];
  let diary: LifeNode | undefined;
  for (const n of lib.nodes) {
    if (dayOf(n.time) !== date) continue;
    if (n.type === 'action') soft.push(n);
    else if (n.type === 'reflect' && !diary) diary = n;
  }
  return { diary, soft };
}

/** 边类型是否在给定节点集合上高亮 */
export const edgeTouches = (e: LifeEdge, set: ReadonlySet<ID>): boolean =>
  set.has(e.fromId) && set.has(e.toId);
