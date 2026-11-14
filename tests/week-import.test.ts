import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAIN_SPACE, WEEK_COL_W, WEEK_REVIEW_TAG, WEEK_ROW_H, buildWeekImports, isWeekReview,
  layoutWeekImports, nodeDay, weekSourceCandidates, weekSpaceId,
} from '../src/model/space';
import { bumpRevision } from '../src/model/selectors';
import { Store } from '../src/model/store';
import type { Library, LifeNode } from '../src/model/types';

/**
 * 阶段三：周画布「引入本周原数据」。
 *
 * 这里钉的是三件事：
 *  1) 引入的是**副本**，且副本记得自己是从哪儿来的（sourceId）
 *  2) 副本与原件**保真**（正文、状态、标签、图、外链一个不少）
 *  3) 副本落在**周空间**里，不污染主画布；坐标按日期横排
 *
 * ★ 硬约束：软件只做「捞、摆、复制」—— 它不生成任何总结文字。
 *   所以这里没有任何一条断言跟"自动摘要"有关。
 */

const MON = '2026-11-02';                 // 周一
const SUN = '2026-11-08';                 // 周日

const mkNode = (id: string, over: Partial<LifeNode> = {}): LifeNode => ({
  id, kind: 'node', spaceId: MAIN_SPACE, type: 'idea', title: id, content: '',
  tags: [], themeIds: [], stageIds: [],
  x: 0, y: 0, w: 200, h: 80,
  createdAt: 0, updatedAt: 0, ...over,
});

const lib = (nodes: LifeNode[]): Library => ({
  nodes, edges: [], themes: [], stages: [], milestones: [], versions: [], customStatuses: [],
});

beforeEach(() => { bumpRevision(); });

/* ============================================================
 * 候选：主空间里这一周的记录
 * ============================================================ */

describe('本周原数据的候选', () => {
  it('只取主空间这一周里的点', () => {
    const l = lib([
      mkNode('a', { time: '2026-11-02' }),
      mkNode('b', { time: '2026-11-08' }),        // 周日也算这一周
      mkNode('c', { time: '2026-11-01' }),        // 上周日 —— 不算
      mkNode('d', { time: '2026-11-09' }),        // 下周一 —— 不算
      mkNode('e', { time: '2026-11-05', spaceId: weekSpaceId(MON) }), // 周空间自己的 —— 不算
    ]);
    expect(weekSourceCandidates(l, MON).map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('按日期排序（同一天按 id 排，顺序稳定）', () => {
    const l = lib([
      mkNode('z', { time: '2026-11-05' }),
      mkNode('a', { time: '2026-11-02' }),
      mkNode('m', { time: '2026-11-05' }),
    ]);
    expect(weekSourceCandidates(l, MON).map((n) => n.id)).toEqual(['a', 'm', 'z']);
  });

  it('只有月粒度的点取不到具体哪天 —— 不进候选', () => {
    const l = lib([mkNode('m', { time: '2026-11' })]);
    expect(weekSourceCandidates(l, MON)).toHaveLength(0);
  });
});

/* ============================================================
 * nodeDay
 * ============================================================ */

describe('nodeDay', () => {
  it('取 time 的日期部分', () => {
    expect(nodeDay(mkNode('a', { time: '2026-11-02' }))).toBe('2026-11-02');
  });
  it('月粒度 / 没有 time ⇒ null（不猜）', () => {
    expect(nodeDay(mkNode('a', { time: '2026-11' }))).toBeNull();
    expect(nodeDay(mkNode('a'))).toBeNull();
  });
});

/* ============================================================
 * 排布：按日期横排
 * ============================================================ */

describe('layoutWeekImports', () => {
  it('周一在最左，周日最右，一周一条横线', () => {
    const pos = layoutWeekImports([
      { id: 'mon', day: MON },
      { id: 'sun', day: SUN },
    ], MON);
    expect(pos.get('mon')!.x).toBe(60);
    expect(pos.get('sun')!.x).toBe(60 + 6 * WEEK_COL_W);
    expect(pos.get('mon')!.y).toBe(60);
    expect(pos.get('sun')!.y).toBe(60);
  });

  it('同一天的多个点往下错开，不叠在一起', () => {
    const pos = layoutWeekImports([
      { id: 'a', day: MON },
      { id: 'b', day: MON },
      { id: 'c', day: MON },
    ], MON);
    expect(pos.get('a')!.y).toBe(60);
    expect(pos.get('b')!.y).toBe(60 + WEEK_ROW_H);
    expect(pos.get('c')!.y).toBe(60 + 2 * WEEK_ROW_H);
    // x 都在同一列
    expect(pos.get('b')!.x).toBe(pos.get('a')!.x);
  });

  it('跨月的周：列号按天数差算，不按"第几个"算', () => {
    const pos = layoutWeekImports([{ id: 'x', day: '2026-11-09' }], MON);
    expect(pos.get('x')!.x).toBe(60 + 7 * WEEK_COL_W);
  });

  it('给了 origin 就整条横线挪过去（引入时落在已有内容下面）', () => {
    const pos = layoutWeekImports([
      { id: 'a', day: MON },
      { id: 'b', day: MON },
    ], MON, { x: 60, y: 500 });
    expect(pos.get('a')!.x).toBe(60);
    expect(pos.get('a')!.y).toBe(500);
    expect(pos.get('b')!.y).toBe(500 + WEEK_ROW_H);
  });
});

/* ============================================================
 * 复制：保真 + 记住来源 + 落在周空间
 * ============================================================ */

describe('buildWeekImports', () => {
  const src = mkNode('orig', {
    type: 'event',
    title: '发布会',
    content: '讲了三十分钟',
    status: '进行中',
    done: true,
    time: '2026-11-03',
    tags: ['工作', '重要'],
    themeIds: ['t1'],
    stageIds: ['s1'],
    w: 300, h: 120,
    imageData: 'data:image/png;base64,AAA',
    imageW: 800, imageH: 600,
    linkUrl: 'https://example.com', linkLabel: '讲稿',
  });

  it('副本内容跟原件一模一样（一个字都不少）', () => {
    const [p] = buildWeekImports([src], MON, weekSpaceId(MON));
    expect(p).toBeTruthy();
    expect(p!.type).toBe('event');
    expect(p!.title).toBe('发布会');
    expect(p!.content).toBe('讲了三十分钟');
    expect(p!.status).toBe('进行中');
    expect(p!.done).toBe(true);
    expect(p!.time).toBe('2026-11-03');
    expect(p!.tags).toEqual(['工作', '重要']);
    expect(p!.themeIds).toEqual(['t1']);
    expect(p!.stageIds).toEqual(['s1']);
    expect(p!.w).toBe(300);
    expect(p!.h).toBe(120);
    expect(p!.imageData).toBe('data:image/png;base64,AAA');
    expect(p!.imageW).toBe(800);
    expect(p!.imageH).toBe(600);
    expect(p!.linkUrl).toBe('https://example.com');
    expect(p!.linkLabel).toBe('讲稿');
  });

  it('副本记住自己是从哪儿复制来的（sourceId = 原件 id）', () => {
    const [p] = buildWeekImports([src], MON, weekSpaceId(MON));
    expect(p!.sourceId).toBe('orig');
  });

  it('副本落在目标空间（周空间），不落回主画布', () => {
    const [p] = buildWeekImports([src], MON, weekSpaceId(MON));
    expect(p!.spaceId).toBe(weekSpaceId(MON));
    expect(p!.spaceId).not.toBe(MAIN_SPACE);
  });

  it('副本落在原件那一天的那一列', () => {
    const [p] = buildWeekImports([src], MON, weekSpaceId(MON));
    expect(p!.x).toBe(60 + WEEK_COL_W);       // 11-03 是周三 ⇒ 第 2 列
    expect(p!.y).toBe(60);
  });

  it('标签 / 归属是拷贝，不是共享同一个数组（改副本不牵连原件）', () => {
    const [p] = buildWeekImports([src], MON, weekSpaceId(MON));
    p!.tags.push('周复盘');
    p!.themeIds.push('t2');
    expect(src.tags).toEqual(['工作', '重要']);
    expect(src.themeIds).toEqual(['t1']);
  });

  it('一个都不选 ⇒ 一个副本都不产生', () => {
    expect(buildWeekImports([], MON, weekSpaceId(MON))).toHaveLength(0);
  });

  it('给了 origin，副本就落在那儿（不压在自己写的点上）', () => {
    // src 的 time 是 2026-11-03（周三）⇒ 列号 1
    const [p] = buildWeekImports([src], MON, weekSpaceId(MON), { x: 60, y: 500 });
    expect(p!.x).toBe(60 + WEEK_COL_W);
    expect(p!.y).toBe(500);
  });
});

/* ============================================================
 * 落库：addNode 得真的把图/链接/来源写进去
 * ============================================================ */

describe('addNode 带上可选字段', () => {
  it('imageData / imageUrl / link / done / sourceId 都得写进去', () => {
    const st = new Store();
    const n = st.addNode({
      type: 'reflect', title: '复盘',
      imageData: 'data:image/png;base64,BBB', imageW: 100, imageH: 50,
      imageUrl: 'https://example.com/a.png',
      linkUrl: 'https://example.com', linkLabel: '链接',
      done: true,
      sourceId: 'orig-1',
    });
    const got = st.lib.nodes.find((x) => x.id === n.id)!;
    expect(got.imageData).toBe('data:image/png;base64,BBB');
    expect(got.imageW).toBe(100);
    expect(got.imageH).toBe(50);
    expect(got.imageUrl).toBe('https://example.com/a.png');
    expect(got.linkUrl).toBe('https://example.com');
    expect(got.linkLabel).toBe('链接');
    expect(got.done).toBe(true);
    expect(got.sourceId).toBe('orig-1');
  });

  it('没传的字段就是没有（不写 undefined 占位）', () => {
    const st = new Store();
    const n = st.addNode({ type: 'idea', title: 'x' });
    const got = st.lib.nodes.find((x) => x.id === n.id)!;
    expect(got.imageData).toBeUndefined();
    expect(got.sourceId).toBeUndefined();
  });

  it('addNode 落在 store 当前的空间里', () => {
    const st = new Store();
    st.currentSpaceId = weekSpaceId(MON);
    const n = st.addNode({ type: 'reflect', title: 'x' });
    expect(n.spaceId).toBe(weekSpaceId(MON));
  });
});

/* ============================================================
 * sourceId 不进版本历史
 * ============================================================ */

describe('sourceId 不进版本历史', () => {
  it('只改 sourceId 不产生版本（它是结构信息，不是"内容修改"）', async () => {
    const st = new Store();
    const n = st.addNode({ type: 'reflect', title: 'x' });
    st.updateNode(n.id, { sourceId: 'orig-1' });
    await new Promise((r) => setTimeout(r, 700));
    expect(st.versionsOf(n.id)).toHaveLength(0);
  });

  it('改标题照旧产生版本（版本历史没被这次改造弄坏）', async () => {
    const st = new Store();
    const n = st.addNode({ type: 'reflect', title: 'a' });
    st.updateNode(n.id, { title: 'b' }, { reason: '改一下' });
    await new Promise((r) => setTimeout(r, 700));
    expect(st.versionsOf(n.id)).toHaveLength(1);
  });
});

/* ============================================================
 * 周复盘标记
 * ============================================================ */

describe('周复盘标记', () => {
  it('reflect + #周复盘 才算周复盘产出', () => {
    expect(isWeekReview(mkNode('a', { type: 'reflect', tags: [WEEK_REVIEW_TAG] }))).toBe(true);
    expect(isWeekReview(mkNode('a', { type: 'reflect', tags: ['日记'] }))).toBe(false);
    expect(isWeekReview(mkNode('a', { type: 'idea', tags: [WEEK_REVIEW_TAG] }))).toBe(false);
  });
});
