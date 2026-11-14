import { describe, expect, it } from 'vitest';
import {
  allStatuses, allTags, applyFilter, describe as describeFilter,
  emptyFilter, filterCount, isFilterActive, monthRange, passes,
  type FilterState,
} from '../src/model/filters';
import type { Library, LifeNode } from '../src/model/types';

const n = (over: Partial<LifeNode> & { id: string }): LifeNode => ({
  kind: 'node', spaceId: 's', type: 'idea', title: over.id, content: '',
  tags: [], themeIds: [], stageIds: [],
  x: 0, y: 0, w: 200, h: 80,
  createdAt: 0, updatedAt: 0, ...over,
});

const lib: Library = {
  nodes: [
    n({ id: 'g1', type: 'goal', status: '进行中', time: '2025-03', tags: ['职业'] }),
    n({ id: 'g2', type: 'goal', status: '已取代', time: '2026-04', tags: ['职业', '转折'] }),
    n({ id: 'i1', type: 'idea', time: '2026-07', tags: ['认知'] }),
    n({ id: 'e1', type: 'event', time: '2024-12' }),
    n({ id: 'f1', type: 'idea' }),                       // 无时间无标签
  ],
  edges: [], themes: [], stages: [], versions: [], milestones: [], customStatuses: [],
};

const F = (over: Partial<FilterState> = {}): FilterState => ({ ...emptyFilter(), ...over });

describe('空筛选', () => {
  it('全部通过且不算激活', () => {
    expect(applyFilter(lib, emptyFilter(), null)).toHaveLength(5);
    expect(isFilterActive(emptyFilter())).toBe(false);
    expect(filterCount(emptyFilter())).toBe(0);
  });
});

describe('状态筛选', () => {
  it('只留对应状态的目标', () => {
    const r = applyFilter(lib, F({ statuses: new Set(['已取代']) }), null);
    expect(r.map((x) => x.id)).toEqual(['g2']);
  });

  it('非目标点在设了状态时被排除 —— 它们没有状态', () => {
    const f = F({ statuses: new Set(['进行中']) });
    expect(applyFilter(lib, f, null).map((x) => x.id)).toEqual(['g1']);
  });

  it('多个状态是 OR', () => {
    const r = applyFilter(lib, F({ statuses: new Set(['进行中', '已取代']) }), null);
    expect(r.map((x) => x.id).sort()).toEqual(['g1', 'g2']);
  });
});

describe('标签筛选', () => {
  it('多标签是 AND', () => {
    const r = applyFilter(lib, F({ tags: new Set(['职业', '转折']) }), null);
    expect(r.map((x) => x.id)).toEqual(['g2']);
  });

  it('没有标签的点会被排除', () => {
    expect(applyFilter(lib, F({ tags: new Set(['职业']) }), null).map((x) => x.id).sort())
      .toEqual(['g1', 'g2']);
  });
});

describe('时间筛选（关键陷阱：无时间的点不该消失）', () => {
  it('范围内的点保留，无时间的点按约定也保留', () => {
    const r = applyFilter(lib, F({ from: '2026-01', to: '2026-12' }), null);
    expect(r.map((x) => x.id).sort()).toEqual(['f1', 'g2', 'i1']);
  });

  it('没写时间的点仍然通过 —— 否则设了时间它们会集体消失', () => {
    const r = applyFilter(lib, F({ from: '2020-01', to: '2030-01' }), null);
    expect(r.map((x) => x.id)).toContain('f1');
  });

  it('只设下限时未来的点也在', () => {
    const r = applyFilter(lib, F({ from: '2026-01' }), null);
    expect(r.map((x) => x.id).sort()).toEqual(['f1', 'g2', 'i1']);
  });

  it('不同日期格式能正确比较', () => {
    const r = applyFilter(lib, F({ from: '2026-04' }), null);
    expect(r.map((x) => x.id)).toContain('g2');
  });
});

describe('多维度组合', () => {
  it('状态 + 标签 + 时间 + 类型同时生效', () => {
    const f = F({
      statuses: new Set(['已取代']),
      tags: new Set(['转折']),
      from: '2026-01', to: '2026-12',
    });
    expect(applyFilter(lib, f, new Set(['goal'] as never)).map((x) => x.id)).toEqual(['g2']);
  });

  it('类型筛选为 0 时视为不限', () => {
    expect(applyFilter(lib, emptyFilter(), new Set())).toHaveLength(5);
  });
});

describe('元数据派生', () => {
  it('allTags 按使用次数降序', () => {
    const t = allTags(lib);
    expect(t[0]).toEqual({ name: '职业', count: 2 });
    expect(t.map((x) => x.count)).toEqual([...t.map((x) => x.count)].sort((a, b) => b - a));
  });

  it('allStatuses 含内置与自定义', () => {
    const withCustom: Library = { ...lib, nodes: [...lib.nodes, n({ id: 'g3', type: 'goal', status: '搁置' })] };
    expect(allStatuses(withCustom)).toContain('搁置');
    expect(allStatuses(withCustom)).toContain('进行中');
  });

  it('monthRange 去重排序', () => {
    expect(monthRange(lib)).toEqual(['2024-12', '2025-03', '2026-04', '2026-07']);
  });

  it('describe 给出人类可读的摘要', () => {
    const f = F({ statuses: new Set(['进行中']), tags: new Set(['职业']), from: '2025-01', to: '2026-12' });
    expect(describeFilter(f)).toEqual(['状态：进行中', '标签：#职业', '从 2025-01', '到 2026-12']);
    expect(describeFilter(emptyFilter())).toEqual([]);
  });
});

describe('passes 是纯函数', () => {
  it('多次调用结果稳定（没有隐藏状态）', () => {
    const f = F({ statuses: new Set(['进行中']) });
    const node = lib.nodes[0]!;
    expect(passes(node, f)).toBe(true);
    expect(passes(node, f)).toBe(true);
    expect(passes(node, emptyFilter())).toBe(true);
  });
});