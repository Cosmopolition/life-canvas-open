import { describe, expect, it, beforeEach } from 'vitest';
import {
  MAIN_SPACE, dayCounts, isoWeekNumber, isWeekReview, isWeekSpace, monthWeeks,
  parseWeekSpace, rangeText, shiftMonth, shiftWeek, spaceTitle, spaceView,
  weekDayCounts, weekDays, weekEnd, weekSpaceId, weekSpaceStats, weekSpaces, weekStart,
} from '../src/model/space';
import { bumpRevision } from '../src/model/selectors';
import { Store } from '../src/model/store';
import { BigramIndex } from '../src/search/indexer';
import type { Library, LifeEdge, LifeNode } from '../src/model/types';

/**
 * 空间隔离是周画布的地基。这里的每条断言都在防同一类事故：
 * **一个空间的内容漏进另一个空间**（或反过来，切空间破坏了用户的布局）。
 */

const mkNode = (id: string, over: Partial<LifeNode> = {}): LifeNode => ({
  id, kind: 'node', spaceId: MAIN_SPACE, type: 'idea', title: id, content: '',
  tags: [], themeIds: [], stageIds: [],
  x: 0, y: 0, w: 200, h: 80,
  createdAt: 0, updatedAt: 0, ...over,
});

const mkEdge = (id: string, fromId: string, toId: string, spaceId = MAIN_SPACE): LifeEdge => ({
  id, kind: 'edge', spaceId, fromId, fromKind: 'node', toId, toKind: 'node',
  type: 'cause', createdAt: 0, updatedAt: 0,
});

const lib = (nodes: LifeNode[], edges: LifeEdge[] = []): Library => ({
  nodes, edges, themes: [], stages: [], milestones: [], versions: [], customStatuses: [],
});

beforeEach(() => { bumpRevision(); });

/* ============================================================
 * 周的计算
 * ============================================================ */

describe('周起始与结束', () => {
  it('周一归到自己', () => {
    expect(weekStart('2026-11-02')).toBe('2026-11-02');
  });

  it('周日归到上一个周一（不是下一个）', () => {
    expect(weekStart('2026-11-08')).toBe('2026-11-02');
    expect(weekStart('2026-11-01')).toBe('2026-10-26');
  });

  it('一周七天，周一到周日', () => {
    expect(weekEnd('2026-11-02')).toBe('2026-11-08');
    const d = weekDays('2026-11-02');
    expect(d).toHaveLength(7);
    expect(d[0]).toBe('2026-11-02');
    expect(d[6]).toBe('2026-11-08');
  });

  it('纯日期不被当成 UTC（东八区不能退一天）', () => {
    // Date.parse('2026-11-02') 按 UTC 解析，在东八区会变成 11-01 19:00。
    // space.ts 用本地构造 + 12 点锚定，任何时区都应是同一天。
    expect(weekStart('2026-11-02')).toBe('2026-11-02');
    expect(weekEnd('2026-11-02')).toBe('2026-11-08');
  });

  it('跨年周：2026-12-28 那周一直到 2027-01-03', () => {
    expect(weekStart('2027-01-01')).toBe('2026-12-28');
    expect(weekEnd('2026-12-28')).toBe('2027-01-03');
  });

  it('shiftWeek 加减整周', () => {
    expect(shiftWeek('2026-11-02', 1)).toBe('2026-11-09');
    expect(shiftWeek('2026-11-02', -1)).toBe('2026-10-26');
    expect(shiftWeek('2026-12-28', 1)).toBe('2027-01-04');
  });
});

describe('ISO 周号', () => {
  it('常规周', () => {
    expect(isoWeekNumber('2026-11-02')).toBe(45);
  });

  it('跨年周是当年的最后一周', () => {
    expect(isoWeekNumber('2026-12-28')).toBe(53);
  });

  it('元旦所在周回到第 1 周', () => {
    expect(isoWeekNumber('2027-01-04')).toBe(1);
  });

  it('2026-01-01 所在周的周数', () => {
    // 2026-01-01 是周四 ⇒ 它属于 2025 年的第 1 周（ISO 规则：含 1 月 4 日的那周）
    expect(isoWeekNumber(weekStart('2026-01-01'))).toBe(1);
  });
});

/* ============================================================
 * 空间身份
 * ============================================================ */

describe('空间身份', () => {
  it('周一日期 → 空间 id', () => {
    expect(weekSpaceId('2026-11-02')).toBe('week:2026-11-02');
    expect(weekSpaceId('2026-11-08')).toBe('week:2026-11-02');   // 周日归到本周
  });

  it('空间 id → 周信息（往返）', () => {
    const w = parseWeekSpace('week:2026-11-02')!;
    expect(w.monday).toBe('2026-11-02');
    expect(w.sunday).toBe('2026-11-08');
    expect(w.weekNo).toBe(45);
    expect(w.label).toBe('第 45 周');
    expect(weekSpaceId(w.monday)).toBe('week:2026-11-02');
  });

  it('非周空间 / 非法日期 / 不是周一 ⇒ null', () => {
    expect(parseWeekSpace(MAIN_SPACE)).toBeNull();
    expect(parseWeekSpace('week:不是日期')).toBeNull();
    expect(parseWeekSpace('week:2026-11-03')).toBeNull();   // 周二 ⇒ 不是周一起点
  });

  it('isWeekSpace 只认 week: 前缀', () => {
    expect(isWeekSpace('week:2026-11-02')).toBe(true);
    expect(isWeekSpace(MAIN_SPACE)).toBe(false);
    expect(isWeekSpace('stress')).toBe(false);
  });

  it('显示名：主画布 / 第 N 周', () => {
    expect(spaceTitle(MAIN_SPACE)).toBe('人生画布');
    expect(spaceTitle('week:2026-11-02')).toBe('第 45 周');
  });

  it('区间文案：同年不带年份，跨年带年份', () => {
    expect(rangeText('2026-11-02', '2026-11-08')).toBe('11/02–11/08');
    expect(rangeText('2026-12-28', '2027-01-03')).toBe('2026/12/28–2027/01/03');
  });
});

/* ============================================================
 * spaceView —— 隔离的核心
 * ============================================================ */

describe('spaceView 空间隔离', () => {
  const main = mkNode('n-main', { title: '主画布的点' });
  const wk = mkNode('n-wk', { spaceId: 'week:2026-11-02', title: '周画布的点' });
  const wk2 = mkNode('n-wk2', { spaceId: 'week:2026-11-09' });
  const e1 = mkEdge('e1', 'n-main', 'n-wk');                       // 跨空间边（脏数据）
  const e2 = mkEdge('e2', 'n-main', 'n-main2', 'week:2026-11-02');
  const main2 = mkNode('n-main2');

  it('只留当前空间的节点', () => {
    const v = spaceView(lib([main, wk, wk2], [e1]), MAIN_SPACE);
    expect(v.nodes.map((n) => n.id)).toEqual(['n-main']);
  });

  it('切到周空间，看到的只有那个周', () => {
    const v = spaceView(lib([main, wk, wk2]), 'week:2026-11-02');
    expect(v.nodes.map((n) => n.id)).toEqual(['n-wk']);
  });

  it('跨空间的边不出现（两端都得在空间内）', () => {
    const v = spaceView(lib([main, wk, wk2], [e1]), MAIN_SPACE);
    expect(v.edges).toHaveLength(0);
  });

  it('空间内的边保留', () => {
    const v = spaceView(lib([main, main2, wk, wk2], [e2]), 'week:2026-11-02');
    expect(v.edges).toHaveLength(0);          // e2 的两端都不在周空间
    const v2 = spaceView(lib([main, main2], [e2]), 'week:2026-11-02');
    expect(v2.edges).toHaveLength(0);
  });

  it('不改动原库（是投影，不是搬家）', () => {
    const l = lib([main, wk], [e1]);
    spaceView(l, 'week:2026-11-02');
    expect(l.nodes).toHaveLength(2);
    expect(l.edges).toHaveLength(1);
    expect(main.spaceId).toBe(MAIN_SPACE);
  });

  it('保留库里其余字段（主题、阶段等）', () => {
    const l = lib([main]);
    l.themes.push({ id: 't1', kind: 'theme', spaceId: MAIN_SPACE, name: '事业', parentId: null, color: '#000', createdAt: 0, updatedAt: 0 });
    const v = spaceView(l, MAIN_SPACE);
    expect(v.themes).toHaveLength(1);
    expect(v.stages).toBe(l.stages);
  });

  it('同一空间连续调用返回同一个对象（缓存命中）', () => {
    const l = lib([main, wk]);
    const a = spaceView(l, MAIN_SPACE);
    const b = spaceView(l, MAIN_SPACE);
    expect(a).toBe(b);
  });

  it('库变了（bumpRevision）之后重算，不是拿旧的缓存', () => {
    const l = lib([main]);
    const before = spaceView(l, MAIN_SPACE);
    expect(before.nodes).toHaveLength(1);
    l.nodes.push(wk);
    bumpRevision();
    const after = spaceView(l, MAIN_SPACE);
    expect(after).not.toBe(before);
    expect(after.nodes).toHaveLength(1);      // wk 在周空间，不在主空间
    expect(spaceView(l, 'week:2026-11-02').nodes).toHaveLength(1);
  });

  it('换空间会重算（不是返回上一个空间的缓存）', () => {
    const l = lib([main, wk]);
    const a = spaceView(l, MAIN_SPACE);
    const b = spaceView(l, 'week:2026-11-02');
    expect(a).not.toBe(b);
    expect(a.nodes).toHaveLength(1);
    expect(b.nodes).toHaveLength(1);
  });
});

/* ============================================================
 * 周复盘标记与统计
 * ============================================================ */

describe('周复盘标记', () => {
  it('reflect + 周复盘 tag 才是周复盘节点', () => {
    expect(isWeekReview(mkNode('a', { type: 'reflect', tags: ['周复盘'] }))).toBe(true);
    expect(isWeekReview(mkNode('a', { type: 'idea', tags: ['周复盘'] }))).toBe(false);
    expect(isWeekReview(mkNode('a', { type: 'reflect', tags: ['别的'] }))).toBe(false);
  });
});

describe('周空间统计', () => {
  it('数节点、认周复盘', () => {
    const l = lib([
      mkNode('n1', { spaceId: 'week:2026-11-02' }),
      mkNode('n2', { spaceId: 'week:2026-11-02' }),
      mkNode('n3', { spaceId: 'week:2026-11-02', type: 'reflect', tags: ['周复盘'] }),
      mkNode('n4', { spaceId: 'week:2026-11-09' }),
      mkNode('n5'),
    ]);
    const s = weekSpaceStats(l);
    expect(s.get('week:2026-11-02')).toEqual({ count: 3, hasReview: true });
    expect(s.get('week:2026-11-09')).toEqual({ count: 1, hasReview: false });
    expect(s.has('default')).toBe(false);
  });

  it('列出所有周空间，按周一升序', () => {
    const l = lib([
      mkNode('n1', { spaceId: 'week:2026-11-09' }),
      mkNode('n2', { spaceId: 'week:2026-11-02' }),
      mkNode('n3'),
    ]);
    expect(weekSpaces(l).map((w) => w.monday)).toEqual(['2026-11-02', '2026-11-09']);
  });
});

/* ============================================================
 * 周历的月-周映射与日计数
 * ============================================================ */

describe('周历：一个月覆盖哪些周', () => {
  it('首周可能从上个月开始，末周可能就是本月最后一天', () => {
    // 2026-11-01 是周日 ⇒ 它属于 10-26 那一周
    const w = monthWeeks('2026-11');
    expect(w[0]).toBe('2026-10-26');
    // 2026-11-30 是周一 ⇒ 它自己是一周的开始
    expect(w[w.length - 1]).toBe('2026-11-30');
  });

  it('跨月：12 月的首周从 11-30 起，末周到 12-28', () => {
    const w = monthWeeks('2026-12');
    expect(w[0]).toBe('2026-11-30');
    expect(w[w.length - 1]).toBe('2026-12-28');
  });

  it('周列表连续，且每一项都是周一', () => {
    const w = monthWeeks('2026-11');
    for (const m of w) expect(weekStart(m)).toBe(m);
    for (let i = 1; i < w.length; i++) expect(w[i]!).toBe(shiftWeek(w[i - 1]!, 1));
  });

  it('月份平移，跨年也对', () => {
    expect(shiftMonth('2026-11', 1)).toBe('2026-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-11', -1)).toBe('2026-10');
  });
});

describe('周历：日计数', () => {
  it('只数主空间的记录，月粒度的时间不算', () => {
    const l = lib([
      mkNode('n1', { time: '2026-11-02' }),
      mkNode('n2', { time: '2026-11-02' }),
      mkNode('n3', { time: '2026-11-03' }),
      mkNode('n4', { time: '2026-11' }),                                  // 月粒度 ⇒ 不计入
      mkNode('n5', { spaceId: 'week:2026-11-02', time: '2026-11-04' }),   // 周空间 ⇒ 不计入
    ]);
    const c = dayCounts(l);
    expect(c.get('2026-11-02')).toBe(2);
    expect(c.get('2026-11-03')).toBe(1);
    expect(c.has('2026-11-04')).toBe(false);
    expect(c.has('2026-11')).toBe(false);
  });

  it('一周七天各自计数，顺序是周一→周日', () => {
    const l = lib([
      mkNode('n1', { time: '2026-11-02' }),
      mkNode('n2', { time: '2026-11-08' }),
      mkNode('n3', { time: '2026-11-08' }),
    ]);
    expect(weekDayCounts(l, '2026-11-02')).toEqual([1, 0, 0, 0, 0, 0, 2]);
  });
});

/* ============================================================
 * 搜索按空间过滤
 * ============================================================ */

describe('搜索按空间过滤', () => {
  it('只返回指定空间的命中；不传空间就是全部', () => {
    const ix = new BigramIndex();
    ix.add({ id: 'a', spaceId: MAIN_SPACE, title: '换工作', content: '', tags: [], reasons: [] });
    ix.add({ id: 'b', spaceId: 'week:2026-11-02', title: '换工作', content: '', tags: [], reasons: [] });
    expect(ix.search('换工作')).toHaveLength(2);
    expect(ix.search('换工作', 200, 'week:2026-11-02').map((h) => h.id)).toEqual(['b']);
    expect(ix.search('换工作', 200, MAIN_SPACE).map((h) => h.id)).toEqual(['a']);
  });

  it('limit 作用于过滤之后，不会被别的空间占掉', () => {
    const ix = new BigramIndex();
    for (let i = 0; i < 10; i++) {
      ix.add({ id: `m${i}`, spaceId: MAIN_SPACE, title: `共同的词${i}`, content: '', tags: [], reasons: [] });
      ix.add({ id: `w${i}`, spaceId: 'week:2026-11-02', title: `共同的词${i}`, content: '', tags: [], reasons: [] });
    }
    const r = ix.search('共同的词', 5, 'week:2026-11-02');
    expect(r).toHaveLength(5);
    expect(r.every((h) => h.id.startsWith('w'))).toBe(true);
  });
});

describe('store 的空间写入', () => {
  it('新建的点落在当前空间', () => {
    const st = new Store();
    expect(st.addNode({ type: 'idea', title: 'x' }).spaceId).toBe(MAIN_SPACE);
  });

  it('切到周空间后，新建的点落在周空间', () => {
    const st = new Store();
    st.currentSpaceId = 'week:2026-11-02';
    expect(st.addNode({ type: 'idea', title: 'x' }).spaceId).toBe('week:2026-11-02');
  });

  it('显式指定 spaceId 时优先于当前空间', () => {
    const st = new Store();
    st.currentSpaceId = 'week:2026-11-02';
    expect(st.addNode({ type: 'idea', title: 'x', spaceId: MAIN_SPACE }).spaceId).toBe(MAIN_SPACE);
  });

  it('拒绝跨空间连线', () => {
    const st = new Store();
    const a = st.addNode({ type: 'idea', title: 'a' });
    st.currentSpaceId = 'week:2026-11-02';
    const b = st.addNode({ type: 'idea', title: 'b' });
    expect(() => st.addEdge({
      fromId: a.id, fromKind: 'node', toId: b.id, toKind: 'node', type: 'cause',
    })).toThrow(/跨空间/);
    expect(st.lib.edges).toHaveLength(0);
  });

  it('同空间连线正常，边带上所在空间', () => {
    const st = new Store();
    st.currentSpaceId = 'week:2026-11-02';
    const a = st.addNode({ type: 'idea', title: 'a' });
    const b = st.addNode({ type: 'idea', title: 'b' });
    const e = st.addEdge({ fromId: a.id, fromKind: 'node', toId: b.id, toKind: 'node', type: 'cause' });
    expect(e.spaceId).toBe('week:2026-11-02');
    expect(st.lib.edges).toHaveLength(1);
  });

  it('切空间不影响已有节点的归属', () => {
    const st = new Store();
    const a = st.addNode({ type: 'idea', title: 'a' });
    st.currentSpaceId = 'week:2026-11-02';
    st.addNode({ type: 'idea', title: 'b' });
    st.currentSpaceId = MAIN_SPACE;
    expect(st.lib.nodes.find((n) => n.id === a.id)!.spaceId).toBe(MAIN_SPACE);
    expect(st.lib.nodes.filter((n) => n.spaceId === MAIN_SPACE)).toHaveLength(1);
  });
});
