/**
 * 空间索引（网格）的纯逻辑测试。
 *
 * 重点是**移动之后索引要立刻是新的**：
 *   拖一个点走的是 insert（不是 setAll），如果 insert 只是"记下脏"、
 *   等下一次全量重建才生效，那这个点在整个拖动过程中
 *   **命中框还是旧位置的** —— 点它选不中，拖远了还会从画布上消失。
 */
import { describe, expect, it } from 'vitest';
import { GridIndex } from '../src/canvas/spatial-index';

const item = (id: string, x: number, y: number, w = 100, h = 50) => ({ id, x, y, w, h });

describe('GridIndex', () => {
  it('setAll 之后能命中', () => {
    const g = new GridIndex();
    g.setAll([item('a', 0, 0)]);
    expect(g.hitTest(10, 10)?.id).toBe('a');
    expect(g.hitTest(500, 500)).toBeNull();
  });

  it('移动之后**立刻**按新位置命中（不能等下一次全量重建）', () => {
    const g = new GridIndex();
    g.setAll([item('a', 0, 0)]);
    // 拖到右边
    g.insert(item('a', 900, 900));
    expect(g.hitTest(910, 910)?.id).toBe('a');
    // 旧位置不该再命中
    expect(g.hitTest(10, 10)).toBeNull();
  });

  it('移动之后视口查询也按新位置（拖出视野 = 从画布上消失）', () => {
    const g = new GridIndex();
    g.setAll([item('a', 0, 0)]);
    g.insert(item('a', 5000, 5000));
    const near = g.query({ x: 0, y: 0, w: 200, h: 200 });
    expect(near.map((i) => i.id)).toEqual([]);
  });

  it('反复移动不会在网格里留下重复项', () => {
    const g = new GridIndex();
    g.setAll([item('a', 0, 0)]);
    for (let i = 1; i <= 5; i++) g.insert(item('a', i * 300, 0));
    const hits = g.query({ x: 0, y: 0, w: 5000, h: 500 });
    expect(hits.filter((i) => i.id === 'a').length).toBe(1);
  });

  it('remove 之后不再命中', () => {
    const g = new GridIndex();
    g.setAll([item('a', 0, 0), item('b', 200, 0)]);
    g.remove('a');
    expect(g.hitTest(10, 10)).toBeNull();
    expect(g.hitTest(210, 10)?.id).toBe('b');
  });
});
