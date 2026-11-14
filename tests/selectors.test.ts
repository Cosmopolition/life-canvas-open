import { beforeEach, describe, expect, it } from 'vitest';
import {
  adjacencyOf, bumpRevision, dayOf, derivedStageBelongEdges, derivedThemeBelongEdges,
  entityKind, expandOneHop, inStage, inTheme, monthOf, nodesInStage, nodesInTheme,
  parentGoalsOf, replaceChain, themeChain, visibleNodesByFocus,
} from '../src/model/selectors';
import { Store } from '../src/model/store';
import type { LifeEdge, LifeNode, LifeStage, LifeTheme } from '../src/model/types';

/**
 * selectors 有一层按 revision 失效的派生缓存（见 selectors.ts）。
 * 测试里每次改图必须 bumpRevision()，否则会读到上一次的缓存 ——
 * 这本身就是这套缓存最危险的地方，值得在测试里显式覆盖。
 */

const mkTheme = (id: string, name: string, parentId: string | null = null): LifeTheme =>
  ({ id, name, parentId, color: '#000', kind: 'theme', spaceId: 's', createdAt: 0, updatedAt: 0 });

const mkStage = (id: string, name: string, start?: string, end?: string): LifeStage =>
  ({ id, name, start, end, color: '#000', kind: 'stage', spaceId: 's', createdAt: 0, updatedAt: 0 });

const mkNode = (id: string, over: Partial<LifeNode> = {}): LifeNode =>
  ({
    id, kind: 'node', spaceId: 's', type: 'idea', title: id, content: '',
    tags: [], themeIds: [], stageIds: [],
    x: 0, y: 0, w: 200, h: 80,
    createdAt: 0, updatedAt: 0, ...over,
  });

const mkEdge = (fromId: string, toId: string, type: LifeEdge['type'] = 'cause'): LifeEdge =>
  ({ id: `e-${fromId}-${toId}`, kind: 'edge', spaceId: 's', fromId, fromKind: 'node', toId, toKind: 'node', type, createdAt: 0, updatedAt: 0 });

function build() {
  const tWork = mkTheme('t-work', '事业（职业）');
  const tBody = mkTheme('t-body', '身心健康');
  const sOld = mkStage('s-old', '2023–2025 星河', '2023-01', '2025-12');
  const sNow = mkStage('s-now', '2026 过渡期', '2026-01', '2026-12');

  const g1 = mkNode('n-g1', { type: 'goal', status: '已取代', themeIds: ['t-work'], stageIds: ['s-old'], time: '2023-06', title: '技术负责人' });
  const g2 = mkNode('n-g2', { type: 'goal', status: '已取代', themeIds: ['t-work'], stageIds: ['s-old'], time: '2025-07', title: '换公司' });
  const g3 = mkNode('n-g3', { type: 'goal', status: '进行中', themeIds: ['t-work'], stageIds: ['s-now'], time: '2026-04', title: '真正的转型' });
  const e1 = mkNode('n-e1', { type: 'event', themeIds: ['t-body'], time: '2026-03' });
  const free = mkNode('n-free', { type: 'idea', themeIds: ['t-work'], tags: ['认知'] });
  // 显式 stageIds 但 time 在所有阶段外 —— 应仍算成员（显式 ∪ 时基取并集）
  const explicit = mkNode('n-exp', { themeIds: ['t-work'], stageIds: ['s-now'], time: '2022-01' });
  // 无 time 但显式 stageIds —— 应仍算成员
  const noTime = mkNode('n-notime', { themeIds: ['t-work'], stageIds: ['s-now'] });
  // 时基命中但无 stageIds —— 应算成员
  const timeOnly = mkNode('n-time', { themeIds: ['t-work'], time: '2026-05' });
  // 时基外 + 无显式 —— 不算成员
  const outside = mkNode('n-out', { themeIds: ['t-work'], time: '2022-01' });

  const edges = [
    mkEdge('n-g1', 'n-g2', 'replace'),
    mkEdge('n-g2', 'n-g3', 'replace'),
    mkEdge('n-g1', 'n-e1'),
    mkEdge('n-free', 'n-g3'),
  ];

  return {
    lib: {
      nodes: [g1, g2, g3, e1, free, explicit, noTime, timeOnly, outside], edges,
      themes: [tWork, tBody], stages: [sOld, sNow],
      versions: [], milestones: [], customStatuses: [],
    },
    tWork, tBody, sOld, sNow,
    g1, g2, g3, e1, free, explicit, noTime, timeOnly, outside,
  };
}

let ctx: ReturnType<typeof build>;
beforeEach(() => { bumpRevision(); ctx = build(); });

describe('themeChain', () => {
  it('主题无根 indirection，链 = [自身]', () => {
    expect(themeChain(ctx.lib, 't-work').map((t) => t.id)).toEqual(['t-work']);
    expect(themeChain(ctx.lib, null)).toEqual([]);
  });

  it('主题可嵌套：子主题会带出父链', () => {
    const parent = mkTheme('tp', '父');
    const child = mkTheme('tc', '子', 'tp');
    const lib = { ...ctx.lib, themes: [parent, child] };
    expect(themeChain(lib, 'tc').map((t) => t.id)).toEqual(['tp', 'tc']);
  });
});

describe('inTheme / nodesInTheme', () => {
  it('inTheme 走 themeIds 直查，不含子主题（子主题需显式归到父才命中）', () => {
    expect(inTheme(ctx.lib, ctx.g1, 't-work')).toBe(true);
    expect(inTheme(ctx.lib, ctx.e1, 't-body')).toBe(true);
    expect(inTheme(ctx.lib, ctx.g1, 't-body')).toBe(false);
  });

  it('nodesInTheme 包含子主题继承', () => {
    const parent = mkTheme('tp', '父');
    const child = mkTheme('tc', '子', 'tp');
    const n = mkNode('n-x', { themeIds: ['tc'] });
    const lib = { ...ctx.lib, themes: [parent, child], nodes: [...ctx.lib.nodes, n] };
    expect(nodesInTheme(lib, 'tp', true).map((x) => x.id)).toContain('n-x');
    expect(nodesInTheme(lib, 'tp', false).map((x) => x.id)).not.toContain('n-x');
  });
});

describe('inStage 谓词（8 例）', () => {
  it('例 1：时基落在范围内（两端闭区间）', () => {
    expect(inStage(ctx.lib, ctx.g3, 's-now')).toBe(true); // 2026-04 落在 [2026-01, 2026-12]
  });

  it('例 2：时基早于 start 或晚于 end → 不算成员', () => {
    expect(inStage(ctx.lib, ctx.outside, 's-now')).toBe(false); // 2022-01
    expect(inStage(ctx.lib, ctx.g1, 's-now')).toBe(false);     // 2023-06 在 s-now 之前
  });

  it('例 3：start 缺失 → 该方向全开（end 之前全包）', () => {
    const stage = mkStage('s-open', '无起', undefined, '2026-12');
    const lib = { ...ctx.lib, stages: [...ctx.lib.stages, stage] };
    const before = mkNode('n-before', { time: '2020-01' });
    const inside = mkNode('n-inside', { time: '2026-06' });
    const after  = mkNode('n-after', { time: '2027-01' });
    expect(inStage(lib, before, 's-open')).toBe(true);
    expect(inStage(lib, inside, 's-open')).toBe(true);
    expect(inStage(lib, after,  's-open')).toBe(false);
  });

  it('例 4：end 缺失 → start 之后全包', () => {
    const stage = mkStage('s-tail', '无止', '2026-01', undefined);
    const lib = { ...ctx.lib, stages: [...ctx.lib.stages, stage] };
    const before = mkNode('n-b', { time: '2025-12' });
    const inside = mkNode('n-i', { time: '2026-06' });
    const after  = mkNode('n-a', { time: '2027-08' });
    expect(inStage(lib, before, 's-tail')).toBe(false);
    expect(inStage(lib, inside, 's-tail')).toBe(true);
    expect(inStage(lib, after,  's-tail')).toBe(true);
  });

  it('例 5：start > end → 视为无效（防御，不自动交换）', () => {
    const stage = mkStage('s-bad', '倒置', '2026-12', '2026-01');
    const lib = { ...ctx.lib, stages: [...ctx.lib.stages, stage] };
    const inside = mkNode('n-x', { time: '2026-06' });
    expect(inStage(lib, inside, 's-bad')).toBe(false);
  });

  it('例 6：节点 time 缺省或格式异常 → 不算时基成员', () => {
    const noTime = mkNode('n-nt', {});
    const bad = mkNode('n-bad-time', { time: 'not-a-date' });
    const lib = { ...ctx.lib, nodes: [...ctx.lib.nodes, noTime, bad] };
    expect(inStage(lib, noTime, 's-now')).toBe(false);
    expect(inStage(lib, bad, 's-now')).toBe(false);
  });

  it('例 7：节点 time 用 YYYY-MM-DD → 截断到月再比', () => {
    const n = mkNode('n-day', { time: '2026-04-15' });
    const lib = { ...ctx.lib, nodes: [...ctx.lib.nodes, n] };
    expect(inStage(lib, n, 's-now')).toBe(true);
  });

  it('例 8：显式 stageIds 永远算成员（与时基取并集）', () => {
    expect(inStage(ctx.lib, ctx.explicit, 's-now')).toBe(true);  // time=2022-01 不在任何阶段
    expect(inStage(ctx.lib, ctx.noTime, 's-now')).toBe(true);     // 无 time 但有显式 stageIds
    expect(inStage(ctx.lib, ctx.timeOnly, 's-now')).toBe(true);   // 时基命中，无显式
  });
});

describe('nodesInStage', () => {
  it('合并显式 + 时基命中，重复去重', () => {
    const got = nodesInStage(ctx.lib, 's-now').map((n) => n.id).sort();
    // s-now 成员：g3 (显式+时基) + exp (显式) + noTime (显式) + timeOnly (时基) + e1 (时基)
    expect(got).toEqual(['n-e1', 'n-exp', 'n-g3', 'n-notime', 'n-time']);
  });
});

describe('多维焦点 visibleNodesByFocus（4 例）', () => {
  it('例 A：theme=null + stage=null → 全部节点', () => {
    const got = visibleNodesByFocus(ctx.lib, null, null).map((n) => n.id).sort();
    expect(got).toEqual(ctx.lib.nodes.map((n) => n.id).sort());
  });

  it('例 B：只勾 theme → 只显该主题节点（不限定阶段）', () => {
    const got = visibleNodesByFocus(ctx.lib, 't-work', null).map((n) => n.id).sort();
    // t-work: g1, g2, g3, free, explicit, noTime, timeOnly, outside（无 e1，因为 e1 属 t-body）
    expect(got).toEqual(['n-exp', 'n-free', 'n-g1', 'n-g2', 'n-g3', 'n-notime', 'n-out', 'n-time']);
  });

  it('例 C：只勾 stage → 只显该阶段成员（不限定主题）', () => {
    const got = visibleNodesByFocus(ctx.lib, null, 's-now').map((n) => n.id).sort();
    // s-now 成员：g3, exp, noTime, timeOnly, e1（e1 time=2026-03 落在 [2026-01, 2026-12]）
    expect(got).toEqual(['n-e1', 'n-exp', 'n-g3', 'n-notime', 'n-time']);
  });

  it('例 D：theme + stage 双勾 → 交集（AND）', () => {
    const got = visibleNodesByFocus(ctx.lib, 't-work', 's-now').map((n) => n.id).sort();
    // s-now ∩ t-work：g3, exp, noTime, timeOnly（e1 不在 t-work）
    expect(got).toEqual(['n-exp', 'n-g3', 'n-notime', 'n-time']);
  });
});

describe('entityKind 跨 kind 识别', () => {
  it('节点 / 主题 / 阶段 都能识别', () => {
    expect(entityKind(ctx.lib, 'n-g1')).toBe('node');
    expect(entityKind(ctx.lib, 't-work')).toBe('theme');
    expect(entityKind(ctx.lib, 's-now')).toBe('stage');
    expect(entityKind(ctx.lib, 'nope')).toBeUndefined();
  });
});

describe('邻接与一跳扩展', () => {
  it('adjacencyOf 区分进出方向', () => {
    const a = adjacencyOf(ctx.lib, 'n-g2');
    expect(a.out.map((e) => e.toId)).toEqual(['n-g3']);
    expect(a.in.map((e) => e.fromId)).toEqual(['n-g1']);
  });

  it('expandOneHop 是对称的一跳，不递归', () => {
    // n-g1 → n-g2 → n-g3：展开 n-g1 应到 n-g2 和 n-e1，不该到 n-g3
    const one = expandOneHop(ctx.lib, ['n-g1']);
    expect(one.has('n-g2')).toBe(true);
    expect(one.has('n-e1')).toBe(true);
    expect(one.has('n-g3')).toBe(false);
  });

  it('缓存会在图变更后失效', () => {
    expect(expandOneHop(ctx.lib, ['n-g1']).size).toBe(3);
    ctx.lib.edges.push(mkEdge('n-g1', 'n-g3'));
    bumpRevision();
    expect(expandOneHop(ctx.lib, ['n-g1']).has('n-g3')).toBe(true);
  });
});

describe('取代链', () => {
  it('能从任意节点还原出完整链条，且按时间正序', () => {
    for (const id of ['n-g1', 'n-g2', 'n-g3']) {
      const chain = replaceChain(ctx.lib, id).map((n) => n.title);
      expect(chain).toEqual(['技术负责人', '换公司', '真正的转型']);
    }
  });

  it('环状取代不会死循环', () => {
    ctx.lib.edges.push(mkEdge('n-g3', 'n-g1', 'replace'));
    bumpRevision();
    const chain = replaceChain(ctx.lib, 'n-g1').map((n) => n.id);
    expect(chain).toEqual(['n-g1', 'n-g2', 'n-g3']);
    expect(new Set(chain).size).toBe(chain.length);
  });
});

describe('派生的属于边', () => {
  it('derivedThemeBelongEdges 从 themeIds 派生', () => {
    const d = derivedThemeBelongEdges(ctx.lib);
    expect(d.find((x) => x.fromId === 'n-g1')?.toId).toBe('t-work');
  });

  it('derivedStageBelongEdges 从 stageIds ∪ 时基派生', () => {
    const d = derivedStageBelongEdges(ctx.lib);
    // n-g3 有 stageIds=['s-now'] 且 time='2026-04' 在范围内 → 派生到 s-now
    expect(d.find((x) => x.fromId === 'n-g3')?.toId).toBe('s-now');
    // n-exp time='2022-01' 在所有阶段范围外，但 stageIds 含 s-now → 仍派生到 s-now
    expect(d.find((x) => x.fromId === 'n-exp')?.toId).toBe('s-now');
  });
});

describe('时间', () => {
  it('monthOf 归一化到月', () => {
    expect(monthOf('2026-04-18')).toBe('2026-04');
    expect(monthOf('2026-04')).toBe('2026-04');
    expect(monthOf('')).toBeUndefined();
    expect(monthOf(undefined)).toBeUndefined();
  });

  it('dayOf 归一化到日（支持 YYYY-MM-DD 和 YYYY-MM-DDTHH:mm）', () => {
    expect(dayOf('2026-10-12')).toBe('2026-10-12');
    expect(dayOf('2026-10-12T09:30')).toBe('2026-10-12');
    expect(dayOf('2026-10')).toBeUndefined();
    expect(dayOf('')).toBeUndefined();
    expect(dayOf(undefined)).toBeUndefined();
  });
});

describe('缓存失效是版本驱动的', () => {
  it('不 bump 就读缓存 = 旧结果（这正是需要单测的原因）', () => {
    expect(nodesInTheme(ctx.lib, 't-work', true)).toHaveLength(8);
    ctx.lib.nodes.push(mkNode('n-new', { themeIds: ['t-work'] }));
    // 故意不 bump：缓存命中，旧结果
    expect(nodesInTheme(ctx.lib, 't-work', true)).toHaveLength(8);
    // store 的任何变更都会自动 bump（通过公开的 addNode 触发）
    const st = new Store();
    st.replaceLibrary(ctx.lib);
    st.addNode(mkNode('n-store', { themeIds: ['t-work'] }));
    expect(nodesInTheme(st.lib, 't-work', true)).toHaveLength(10); // 8 原有 + n-new + n-store
  });
});

describe('parentGoalsOf（详情画布专用：相邻的父目标候选）', () => {
  // 新增一个 action + goal + 一些边，专门测父子关系
  it('support action→goal 命中', () => {
    const a1 = mkNode('n-a1', { type: 'action', title: '每周投 3 家公司', time: '2026-08' });
    const lib = { ...ctx.lib, nodes: [...ctx.lib.nodes, a1], edges: [...ctx.lib.edges, mkEdge('n-a1', 'n-g3', 'support')] };
    bumpRevision();
    expect(parentGoalsOf(lib, 'n-a1').map((g) => g.id)).toEqual(['n-g3']);
  });

  it('replace goal→goal 不算父目标（取代关系，非父子）', () => {
    // n-g2 同时是 n-g1 → n-g2 → n-g3 取代链中段
    expect(parentGoalsOf(ctx.lib, 'n-g2').map((g) => g.id)).toEqual([]);
    expect(parentGoalsOf(ctx.lib, 'n-g1').map((g) => g.id)).toEqual([]);
    expect(parentGoalsOf(ctx.lib, 'n-g3').map((g) => g.id)).toEqual([]);
  });

  it('goal→action support 反向命中（action 是 to 端，goal 是 from 端）', () => {
    const a2 = mkNode('n-a2', { type: 'action', title: '准备面试' });
    const lib = { ...ctx.lib, nodes: [...ctx.lib.nodes, a2], edges: [...ctx.lib.edges, mkEdge('n-g3', 'n-a2', 'support')] };
    bumpRevision();
    expect(parentGoalsOf(lib, 'n-a2').map((g) => g.id)).toEqual(['n-g3']);
  });

  it('多条边指向同一 goal → 去重', () => {
    const a3 = mkNode('n-a3', { type: 'action', title: '计划 + 执行' });
    const lib = {
      ...ctx.lib,
      nodes: [...ctx.lib.nodes, a3],
      edges: [...ctx.lib.edges, mkEdge('n-a3', 'n-g3', 'support'), mkEdge('n-a3', 'n-g3', 'cause')],
    };
    bumpRevision();
    expect(parentGoalsOf(lib, 'n-a3').map((g) => g.id)).toEqual(['n-g3']);
  });

  it('非 goal 邻居（action / event / idea）不算父目标', () => {
    // n-g1 → n-e1（event）：e1 不是 goal，所以不是 g1 的父目标
    expect(parentGoalsOf(ctx.lib, 'n-g1').map((g) => g.id)).toEqual([]);
    // n-free → n-g3（idea → goal）：free 是 idea，不是 goal
    // n-g3 自己有父目标候选吗？看 g3 的邻居：g3 邻居只有 g2 (replace) 和 free (idea) → 都不算
    expect(parentGoalsOf(ctx.lib, 'n-g3').map((g) => g.id)).toEqual([]);
  });

  it('theme / stage 不在 adj.all —— 双层防御', () => {
    // lib.themes 和 lib.stages 节点不进 adj 邻接 —— parentGoalsOf 不会算进
    const a4 = mkNode('n-a4', { type: 'action', title: 'x' });
    // 手动塞一条 action → theme 的伪边（实际不会入库，这里只测代码路径不会崩）
    const e = mkEdge('n-a4', 't-work', 'reference');
    const lib = { ...ctx.lib, nodes: [...ctx.lib.nodes, a4], edges: [...ctx.lib.edges, e] };
    bumpRevision();
    // theme/stage 不在 nodes，按 byId(lib.nodes, ...) 找不到 → 不算
    expect(parentGoalsOf(lib, 'n-a4').map((g) => g.id)).toEqual([]);
  });

  it('按 time 升序排列；无 time 时按 id 字典序', () => {
    const a = mkNode('n-a', { type: 'action' });
    const gOld = mkNode('n-g-old', { type: 'goal', title: 'old', time: '2020-01' });
    const gNew = mkNode('n-g-new', { type: 'goal', title: 'new', time: '2027-01' });
    const lib = {
      ...ctx.lib,
      nodes: [...ctx.lib.nodes, a, gOld, gNew],
      edges: [...ctx.lib.edges, mkEdge('n-a', 'n-g-new', 'support'), mkEdge('n-a', 'n-g-old', 'support')],
    };
    bumpRevision();
    expect(parentGoalsOf(lib, 'n-a').map((g) => g.id)).toEqual(['n-g-old', 'n-g-new']);
  });
});
