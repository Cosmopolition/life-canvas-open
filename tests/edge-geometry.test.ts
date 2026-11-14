/**
 * 连线几何的纯逻辑测试。
 *
 * 这里测的是三件以前会**静默出错**的事：
 *   1. 同一对点之间的多条线必须**分道** —— 否则看上去只有一条，
 *      而且鼠标只可能选中其中一条（还可能选错）。
 *   2. 命中测试必须命中**画出来的那条曲线** —— 不是"算一遍差不多的"。
 *      两份几何各算各的，症状就是"指着线点不中"。
 *   3. 箭头方向要跟着曲线走 —— 目标在左边时箭头不能朝节点里面指。
 */
import { describe, expect, it } from 'vitest';
import {
  EdgeGeometry, curvePoint, edgeCurve, laneOffsets, nodeSizeOf,
} from '../src/canvas/edge-geometry';
import { emptyLibrary, type EdgeType, type Library, type LifeEdge, type LifeNode } from '../src/model/types';

function node(id: string, x: number, y: number, w = 240, h = 78): LifeNode {
  return {
    id, kind: 'node', spaceId: 'default', createdAt: 0, updatedAt: 0,
    type: 'idea', title: id, content: '', tags: [], themeIds: [], stageIds: [],
    x, y, w, h,
  };
}

function edge(id: string, fromId: string, toId: string, type: EdgeType, createdAt = 0): LifeEdge {
  return {
    id, kind: 'edge', spaceId: 'default', createdAt, updatedAt: createdAt,
    fromId, fromKind: 'node', toId, toKind: 'node', type,
  };
}

function libWith(nodes: LifeNode[], edges: LifeEdge[]): Library {
  const lib = emptyLibrary();
  lib.nodes = nodes;
  lib.edges = edges;
  return lib;
}

describe('节点尺寸', () => {
  it('短标题用默认高度', () => {
    expect(nodeSizeOf(node('a', 0, 0)).h).toBe(78);
  });

  it('长标题变高（没显式给高度时按标题长度兜底）', () => {
    const n = node('a', 0, 0);
    n.h = 0;                      // h = 0 才走"按标题长度算"这条分支
    n.title = '一二三四五六七八九十一二三四五六七八九十';
    expect(nodeSizeOf(n).h).toBe(96);
  });

  it('有贴图的点更高（图片占纵向空间）', () => {
    const n = node('a', 0, 0);
    n.imageData = 'data:image/png;base64,x';
    expect(nodeSizeOf(n).h).toBe(96);
  });
});

describe('分道：同一对端点的多条线', () => {
  it('一条线没有偏移', () => {
    const m = laneOffsets([edge('e1', 'a', 'b', 'support')]);
    expect(m.get('e1')).toBe(0);
  });

  it('两条线错开、方向相反也错开', () => {
    const m = laneOffsets([
      edge('e1', 'a', 'b', 'support', 1),
      edge('e2', 'b', 'a', 'conflict', 2),
    ]);
    expect(m.get('e1')).not.toBe(m.get('e2'));
  });

  it('偏移对称分布（第 1 条不是最偏的那条）', () => {
    const m = laneOffsets([
      edge('e1', 'a', 'b', 'support', 1),
      edge('e2', 'a', 'b', 'cause', 2),
      edge('e3', 'a', 'b', 'conflict', 3),
    ]);
    const offs = [m.get('e1')!, m.get('e2')!, m.get('e3')!];
    expect(offs[0]).toBeLessThan(offs[1]!);
    expect(offs[1]).toBeLessThan(offs[2]!);
    expect(offs[0]).toBe(-offs[2]!);
  });

  it('不同端点组之间互不影响', () => {
    const m = laneOffsets([
      edge('e1', 'a', 'b', 'support'),
      edge('e2', 'a', 'c', 'support'),
    ]);
    expect(m.get('e1')).toBe(0);
    expect(m.get('e2')).toBe(0);
  });
});

describe('锚点朝向', () => {
  it('目标在右边：源点从右边出、目标从左边进', () => {
    const c = edgeCurve({ x: 0, y: 0, w: 200, h: 80 }, { x: 400, y: 0, w: 200, h: 80 });
    expect(c.a.x).toBe(200);   // 源点右边缘
    expect(c.b.x).toBe(400);   // 目标左边缘
  });

  it('目标在左边：源点从左边出、目标从右边进（不再绕回节点身上）', () => {
    const c = edgeCurve({ x: 400, y: 0, w: 200, h: 80 }, { x: 0, y: 0, w: 200, h: 80 });
    expect(c.a.x).toBe(400);   // 源点左边缘
    expect(c.b.x).toBe(200);   // 目标右边缘
  });

  it('上下相邻时走上/下边', () => {
    const c = edgeCurve({ x: 0, y: 0, w: 200, h: 80 }, { x: 0, y: 300, w: 200, h: 80 });
    expect(c.horizontal).toBe(false);
    expect(c.a.y).toBe(80);    // 源点下边缘
    expect(c.b.y).toBe(300);   // 目标上边缘
  });

  it('箭头方向跟着曲线走（目标在左边时朝左）', () => {
    const c = edgeCurve({ x: 400, y: 0, w: 200, h: 80 }, { x: 0, y: 0, w: 200, h: 80 });
    expect(c.dir.x).toBeLessThan(0);
  });
});

describe('命中测试用同一份几何', () => {
  const nodes = [node('a', 0, 0), node('b', 400, 0)];

  it('命中鼠标下方的边', () => {
    const lib = libWith(nodes, [edge('e1', 'a', 'b', 'support')]);
    const geo = new EdgeGeometry();
    geo.ensure(lib, 1);
    const c = geo.curve(lib.edges[0]!)!;
    const p = curvePoint(c, 0.5);
    expect(geo.hitTest(lib, p.x, p.y, 7)).toBe('e1');
  });

  it('离得远就不命中', () => {
    const lib = libWith(nodes, [edge('e1', 'a', 'b', 'support')]);
    const geo = new EdgeGeometry();
    geo.ensure(lib, 1);
    expect(geo.hitTest(lib, 0, 900, 7)).toBeNull();
  });

  it('两条平行线：各自能命中自己那一条', () => {
    const lib = libWith(nodes, [
      edge('e1', 'a', 'b', 'support', 1),
      edge('e2', 'a', 'b', 'conflict', 2),
    ]);
    const geo = new EdgeGeometry();
    geo.ensure(lib, 1);
    const c1 = geo.curve(lib.edges[0]!)!;
    const c2 = geo.curve(lib.edges[1]!)!;
    const p1 = curvePoint(c1, 0.5);
    const p2 = curvePoint(c2, 0.5);
    // 两条线在几何上**不重合** —— 这是"分得清"的前提
    expect(Math.abs(p1.y - p2.y)).toBeGreaterThan(4);
    expect(geo.hitTest(lib, p1.x, p1.y, 7)).toBe('e1');
    expect(geo.hitTest(lib, p2.x, p2.y, 7)).toBe('e2');
  });
});
