/**
 * 空间（Space）—— 画布的隔离单位。
 *
 * 一个空间 = 一块独立的画布：
 *   - 主画布      'default'
 *   - 每周复盘画布 'week:2026-11-02'（**周一日期就是身份**）
 *
 * ★ 关键约定：**不新增 spaces 表**。空间的标题、起止、周次全部从
 *   spaceId 字符串本身解析出来 —— 空间身份就是它的 id。
 *   库、加密、版本历史、搜索索引全部复用，它们本来就不区分空间。
 *
 * ★ 核心手法：`spaceView()` 把库投影成"只有当前空间的视图"。
 *   调用方（视图层、渲染层、选择器）拿到的已经是过滤好的 lib，
 *   所以绝大多数代码不需要知道自己正在处理哪个空间。
 *
 * 见 docs/ARCHITECTURE.md §3
 */
import { graphRevision } from './selectors';
import type { GoalStatus, ID, LifeEdge, LifeNode, Library, NodeType } from './types';
import { t } from '../i18n';
import { WEEKDAY_KEY } from '../i18n/contracts';

export const MAIN_SPACE = 'default';
export const WEEK_PREFIX = 'week:';

/** 周复盘节点的标记 tag（设计稿 v3 §5.2） */
export const WEEK_REVIEW_TAG = '周复盘';

export type SpaceKind = 'main' | 'week';

/** 一个周空间的解析结果 */
export interface WeekSpace {
  kind: 'week';
  /** 'week:2026-11-02' */
  spaceId: string;
  /** 周一，YYYY-MM-DD */
  monday: string;
  /** 周日，YYYY-MM-DD */
  sunday: string;
  /** ISO 周号（周一为首，含 1 月 4 日的那一周 = 第 1 周） */
  weekNo: number;
  /** '第 45 周' */
  label: string;
  /** '11/02–11/08'（跨年时带年份） */
  range: string;
}

/* ============================================================
 * 日期工具
 *
 * ⚠️ 不用 Date.parse('2026-11-02') —— 纯日期形式按 **UTC** 解析，
 *   在东八区会退到前一天。也不复用 today-view 的 `new Date(s + 'T12:00')`，
 *   那是另一套语义。这里统一用本地构造 + 12 点锚定，避开夏令时边界。
 * ============================================================ */

const pad = (n: number): string => String(n).padStart(2, '0');

const fmt = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 解析 YYYY-MM-DD，容忍 'YYYY-MM-DDTHH:mm' 这类带时间的写法 */
function parseDay(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) throw new Error(`不是合法的日期：${s}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

/** 宽松版：解析失败返回 null（给 UI 用，不抛） */
export function tryParseDay(s: string | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

/* ============================================================
 * 周的计算（周一 → 周日）
 * ============================================================ */

/** 该日期所在周的周一 */
export function weekStart(date: string): string {
  const d = parseDay(date);
  const dow = (d.getDay() + 6) % 7;          // 周一 = 0 … 周日 = 6
  d.setDate(d.getDate() - dow);
  return fmt(d);
}

/** 该日期所在周的周日 */
export function weekEnd(date: string): string {
  const d = parseDay(weekStart(date));
  d.setDate(d.getDate() + 6);
  return fmt(d);
}

/** 周一 ± n 周 */
export function shiftWeek(monday: string, delta: number): string {
  const d = parseDay(monday);
  d.setDate(d.getDate() + delta * 7);
  return fmt(d);
}

/** 该周的 7 天（周一 → 周日） */
export function weekDays(monday: string): string[] {
  const out: string[] = [];
  const d = parseDay(monday);
  for (let i = 0; i < 7; i++) {
    out.push(fmt(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * ISO 8601 周号。
 *
 * 周一为首，含 1 月 4 日的那一周算第 1 周。跨年正确：
 *   2026-11-02 → 45
 *   2026-12-28 → 53   （2026 有 53 个 ISO 周）
 *   2027-01-04 → 1
 */
export function isoWeekNumber(monday: string): number {
  const d = parseDay(monday);
  d.setDate(d.getDate() + 3);                 // 移到本周周四
  const jan4 = new Date(d.getFullYear(), 0, 4, 12, 0);
  const dow = (jan4.getDay() + 6) % 7;
  jan4.setDate(jan4.getDate() - dow);          // 1 月 4 日所在周的周一
  const diff = Math.round((d.getTime() - jan4.getTime()) / 86400000);
  return 1 + Math.round(diff / 7);
}

/* ============================================================
 * 空间身份
 * ============================================================ */

export function isWeekSpace(spaceId: string): boolean {
  return spaceId.startsWith(WEEK_PREFIX);
}

/** 周一日期 → 空间 id */
export function weekSpaceId(monday: string): string {
  return WEEK_PREFIX + weekStart(monday);
}

/**
 * 解析周空间。非周空间、日期非法、或不是周一 ⇒ null。
 * （不是周一 ⇒ null 是有意的：`week:2026-11-03` 是个坏 id，
 *   与其猜它是哪一周的，不如当作不存在。）
 */
export function parseWeekSpace(spaceId: string): WeekSpace | null {
  if (!isWeekSpace(spaceId)) return null;
  const monday = spaceId.slice(WEEK_PREFIX.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monday)) return null;
  if (weekStart(monday) !== monday) return null;
  const sunday = weekEnd(monday);
  const weekNo = isoWeekNumber(monday);
  return {
    kind: 'week',
    spaceId,
    monday,
    sunday,
    weekNo,
    // getter：周次标签跟着界面语言走。写死成普通属性的话，
    // 切语言后已经解析出来的空间会留着旧语言的标签。
    get label(): string {
      return t('week.numberLabel', { n: weekNo });
    },
    range: rangeText(monday, sunday),
  };
}

/** '11/02–11/08'；跨年时带年份（'2026/12/28–2027/01/03'） */
export function rangeText(monday: string, sunday: string): string {
  const a = parseDay(monday);
  const b = parseDay(sunday);
  const mm = (d: Date): string => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  if (a.getFullYear() === b.getFullYear()) return `${mm(a)}–${mm(b)}`;
  return `${a.getFullYear()}/${mm(a)}–${b.getFullYear()}/${mm(b)}`;
}

/** '11/02 周一' / '11/02 Mon' */
export function dayLabel(day: string): string {
  const d = parseDay(day);
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const wd = names[(d.getDay() + 6) % 7] ?? '周一';
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${t(WEEKDAY_KEY[wd]!)}`;
}

/** 空间的显示名 */
export function spaceTitle(spaceId: string): string {
  if (spaceId === MAIN_SPACE) return t('app.name');
  const w = parseWeekSpace(spaceId);
  return w ? w.label : spaceId;
}

/* ============================================================
 * 空间内容
 * ============================================================ */

export function nodesInSpace(lib: Library, spaceId: string): LifeNode[] {
  return lib.nodes.filter((n) => n.spaceId === spaceId);
}

/** 空间内的边 —— 两端都必须在这个空间（跨空间边不允许存在） */
export function edgesInSpace(lib: Library, spaceId: string): LifeEdge[] {
  const ids = new Set(nodesInSpace(lib, spaceId).map((n) => n.id));
  return lib.edges.filter((e) => ids.has(e.fromId) && ids.has(e.toId));
}

/** 这个节点是不是「某一周的周复盘」 */
export function isWeekReview(n: LifeNode): boolean {
  return n.type === 'reflect' && n.tags.includes(WEEK_REVIEW_TAG);
}

/* ============================================================
 * ★ spaceView —— 把库投影成"只有当前空间"
 * ============================================================ */

/**
 * 把库投影成只有某个空间的视图。
 *
 * 这是整个多空间改造的核心：**调用方拿到的 lib 已经过滤好了**，
 * 所以视图层、渲染层、选择器绝大多数代码不需要知道自己处理的是哪个空间。
 *
 * 边的过滤用"两端都在空间内"—— 跨空间边本来就不允许存在，
 * 万一有脏数据也不会漏进周画布。
 */
export function spaceView(lib: Library, spaceId: string): Library {
  const rev = graphRevision();
  if (svCache && svCache.lib === lib && svCache.rev === rev && svCache.spaceId === spaceId) {
    return svCache.view;
  }
  const nodes = nodesInSpace(lib, spaceId);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = lib.edges.filter((e) => ids.has(e.fromId) && ids.has(e.toId));
  const view: Library = { ...lib, nodes, edges };
  svCache = { rev, lib, spaceId, view };
  return view;
}

let svCache: { rev: number; lib: Library; spaceId: string; view: Library } | null = null;

/**
 * 各周空间的统计：spaceId → { 节点数, 有没有周复盘 }。
 *
 * 周历视图每个月要问 5~6 次「这一周有几个点」，逐次 filter 整库是 O(周数×库大小)。
 * 这里一次算完。
 */
export interface WeekSpaceStat {
  count: number;
  hasReview: boolean;
}

export function weekSpaceStats(lib: Library): Map<string, WeekSpaceStat> {
  const out = new Map<string, WeekSpaceStat>();
  for (const n of lib.nodes) {
    if (!isWeekSpace(n.spaceId)) continue;
    let s = out.get(n.spaceId);
    if (!s) { s = { count: 0, hasReview: false }; out.set(n.spaceId, s); }
    s.count++;
    if (isWeekReview(n)) s.hasReview = true;
  }
  return out;
}

/** 库里存在哪些周空间（按周一日期升序） */
export function weekSpaces(lib: Library): WeekSpace[] {
  const seen = new Set<string>();
  for (const n of lib.nodes) if (isWeekSpace(n.spaceId)) seen.add(n.spaceId);
  const out: WeekSpace[] = [];
  for (const id of seen) {
    const w = parseWeekSpace(id);
    if (w) out.push(w);
  }
  return out.sort((a, b) => a.monday.localeCompare(b.monday));
}

/* ============================================================
 * 周历要用的纯计算
 * ============================================================ */

/**
 * 该月覆盖的所有周（周一起始）。
 *
 * 首周可能从上个月就开始，末周可能延伸到下个月 —— 日历就是这样的，
 * 所以跨月的那些天也要出现在格子里（只是颜色淡一点）。
 */
export function monthWeeks(month: string): string[] {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return [];
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const first = new Date(y, mo - 1, 1, 12);
  const last = new Date(y, mo, 0, 12);          // 该月最后一天
  const start = weekStart(fmt(first));
  const end = weekStart(fmt(last));
  const out: string[] = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = shiftWeek(cur, 1);
  }
  return out;
}

/**
 * 主空间里每天的记录数（按节点 time 的日期部分）。
 *
 * 只算**主空间** —— 日历要回答的是"你这周在哪儿留下了东西"，
 * 周画布里自己写的东西不算数（那是产出，不是记录）。
 */
export function dayCounts(lib: Library): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of lib.nodes) {
    if (n.spaceId !== MAIN_SPACE) continue;
    const d = /^(\d{4}-\d{2}-\d{2})/.exec(n.time ?? '');
    if (!d) continue;
    const day = d[1]!;
    out.set(day, (out.get(day) ?? 0) + 1);
  }
  return out;
}

/** 某一周 7 天各自的主空间记录数（周一 → 周日） */
export function weekDayCounts(lib: Library, monday: string): number[] {
  const counts = dayCounts(lib);
  return weekDays(monday).map((d) => counts.get(d) ?? 0);
}

/** 月份平移：'2026-11' ± n 月 */
export function shiftMonth(month: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1, 12);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** 本月（本地时区）'YYYY-MM' */
export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/* ============================================================
 * 引入原数据的排布
 * ============================================================ */

/** 一列多宽（周一→周日横排，每列一个"日"） */
export const WEEK_COL_W = 280;
/** 同一列里错开的行高 */
export const WEEK_ROW_H = 110;

/**
 * 把引入的副本按日期横排 —— 一周在周画布上是一条横线。
 *
 * x = 周一→周日（每列 WEEK_COL_W），y 从 60 起，同一天多个往下错开。
 * 之后你可以随便拖 —— 这只是给一个起点。
 *
 * origin：把整条横线挪到别处（引入时落在周空间已有内容**下面**，
 * 别把副本压在自己写的点上）。
 */
export function layoutWeekImports(
  items: ReadonlyArray<{ id: ID; day: string }>,
  monday: string,
  origin?: { x: number; y: number },
): Map<ID, { x: number; y: number }> {
  const ox = origin?.x ?? 60;
  const oy = origin?.y ?? 60;
  const base = Date.parse(monday + 'T12:00');
  const perCol = new Map<number, number>();
  const out = new Map<ID, { x: number; y: number }>();
  for (const it of items) {
    const t = Date.parse(it.day + 'T12:00');
    const c = Number.isNaN(t) ? 0 : Math.round((t - base) / 86400000);
    const row = perCol.get(c) ?? 0;
    perCol.set(c, row + 1);
    out.set(it.id, { x: ox + c * WEEK_COL_W, y: oy + row * WEEK_ROW_H });
  }
  return out;
}

/**
 * 某个空间里，从主空间"这一周"的记录。
 *
 * 只取**主空间**（MAIN_SPACE）里 time 的日期部分落在这一周的节点 ——
 * 周画布自己写的东西不算"原数据"。
 */
export function weekSourceCandidates(lib: Library, monday: string): LifeNode[] {
  const sunday = weekEnd(monday);
  const out: LifeNode[] = [];
  for (const n of lib.nodes) {
    if (n.spaceId !== MAIN_SPACE) continue;
    const d = /^(\d{4}-\d{2}-\d{2})/.exec(n.time ?? '');
    if (!d) continue;
    if (d[1]! >= monday && d[1]! <= sunday) out.push(n);
  }
  return out.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? '') || a.id.localeCompare(b.id));
}

/* ============================================================
 * 引入原数据：把主空间的节点复制成周空间里的副本
 * ============================================================ */

/**
 * 节点落在哪一天（time 的日期部分）。
 *
 * 只认日粒度（'YYYY-MM-DD'）。月粒度（'YYYY-MM'）取不到具体哪天 ⇒ null
 * —— 猜一个位置等于凭空造一个事实，宁可排到周一开始那一列。
 */
export function nodeDay(n: LifeNode): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(n.time ?? '');
  return m ? m[1]! : null;
}

/** 引入副本要落库的内容（交给 store.addNode 落） */
export interface WeekImportPayload {
  type: NodeType;
  title: string;
  content: string;
  status?: GoalStatus;
  done?: boolean;
  time?: string;
  tags: string[];
  themeIds: ID[];
  stageIds: ID[];
  x: number;
  y: number;
  w: number;
  h: number;
  /** 记住自己是从哪个节点复制来的 —— 「回原文」靠它 */
  sourceId: ID;
  /** 副本落在哪个空间（周空间） */
  spaceId: ID;
  imageData?: string;
  imageW?: number;
  imageH?: number;
  imageUrl?: string;
  linkUrl?: string;
  linkLabel?: string;
}

/**
 * 把选中的主空间节点变成周空间里的副本。
 *
 * ★ 是**复制**不是引用：副本与原件从此分叉 —— 上周当时的理解就该定格，
 *   后来主画布上改了，周画布里的那份不受影响（设计稿 v3 §5.4）。
 *
 * 位置按日期横排（周一→周日一条横线），只是起点，之后随便拖。
 */
export function buildWeekImports(
  sources: ReadonlyArray<LifeNode>,
  monday: string,
  targetSpaceId: ID,
  origin?: { x: number; y: number },
): WeekImportPayload[] {
  const items = sources.map((n) => ({ id: n.id, day: nodeDay(n) ?? monday }));
  const pos = layoutWeekImports(items, monday, origin);
  const out: WeekImportPayload[] = [];
  for (const n of sources) {
    const p = pos.get(n.id);
    if (!p) continue;
    out.push({
      type: n.type, title: n.title, content: n.content,
      status: n.status, done: n.done, time: n.time,
      tags: [...n.tags], themeIds: [...n.themeIds], stageIds: [...n.stageIds],
      x: p.x, y: p.y, w: n.w, h: n.h,
      sourceId: n.id, spaceId: targetSpaceId,
      imageData: n.imageData, imageW: n.imageW, imageH: n.imageH,
      imageUrl: n.imageUrl, linkUrl: n.linkUrl, linkLabel: n.linkLabel,
    });
  }
  return out;
}
